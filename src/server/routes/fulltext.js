const bluebird = require('bluebird')
const _ = require('lodash')
const express = require('express')
const router = express.Router({ mergeParams: true })
const api = require('./api')
const { send } = require('./api/helpers')

router.get('/', api.populateBodyWithDefaults, showStudies)
router.get('/:status', api.populateBodyWithDefaults, showStudies)
router.get('/:status/:page', api.populateBodyWithDefaults, showStudies)

const kStatusList = [
  {status: 'pending', name: 'screen'},
  {status: 'awaiting_coscreener', name: 'awaiting'},
  {status: 'conflict', name: 'in conflict'},
  {status: 'excluded', name: 'excluded'},
  {status: 'included', name: 'included'}
]

const kResultsPerPage = 100

function apiGetStudies (user, apiParams) {
  return send('/studies', user, { qs: apiParams })
}

function showStudies (req, res) {
  const { reviewId, user } = req.body
  let shownStatus = req.params.status || 'pending'
  let pageNum = parseInt(req.params.page) || 1
  let orderBy = req.query.order_by || 'recency'

  let apiParams = {
    review_id: reviewId,
    fields: 'id,citation.title,citation.authors,citation.journal_name,citation.pub_year',
    fulltext_status: shownStatus,
    tag: req.query.tag || undefined,
    tsquery: req.query.tsquery || undefined,
    order_by: orderBy,
    // order_dir can be 'ASC' or 'DESC'; assume the default is the choice that makes sense.
    page: pageNum - 1,
    per_page: kResultsPerPage
  }

  return bluebird.join(
    api.progress.get(req.body, 'True', 'fulltext_screening'),
    api.plans.get(req.body),
    api.users.getTeam(user, req.body),
    api.citations.getTags(req.body, pageNum),
    apiGetStudies(user, apiParams),
    (progress, plan, users, tags, studies) => {
      let userMap = _.fromPairs(users.map(u => [u.id, u.name]))
      let countResults = progress.fulltext_screening[shownStatus] || 0
      let numPages = Math.max(Math.ceil(countResults / kResultsPerPage), 1)
      let firstNavPage = _.clamp(pageNum - 5, 1, numPages)
      let lastNavPage = _.clamp(firstNavPage + 9, 1, numPages)

      let keytermsRE = getKeytermsRE(plan.keyterms)
      for (let study of studies) {
        markKeywordsCitation(study.citation, keytermsRE)
      }

      res.render('fulltext/show', {
        reviewId: reviewId,
        studies: studies,
        page: pageNum,
        numPages: numPages,
        range: _.range(firstNavPage, lastNavPage + 1),
        progress: progress.fulltext_screening,
        selectionCriteria: plan.selection_criteria,
        shownStatus: shownStatus,
        statusList: kStatusList,
        order_by: orderBy,
        tsquery: req.query.tsquery,
        tag: req.query.tag,
        users: userMap,
        userId: user.user_id,
        tags: tags,
        urlPageBase: `/reviews/${reviewId}/fulltext/${shownStatus}`
      })
    }
  )
}

function getKeytermsRE (keyterms) {
  // Collect all keyterms and synonyms.
  let termSet = new Set()
  for (let term of keyterms) {
    termSet.add(term.term)
    for (let syn of term.synonyms) {
      termSet.add(syn)
    }
  }

  // Convert to an array, sorted by decreasing length.
  let sortedTerms = Array.from(termSet).sort((a, b) => (b.length - a.length))
  let escapedTerms = sortedTerms.map(term => _.escapeRegExp(term))
  return new RegExp(escapedTerms.join('|'), 'gi')
}

function markKeywordsCitation (citation, keytermsRE) {
  if (citation) {
    citation.title = markKeywords(citation.title, keytermsRE)
    citation.abstract = markKeywords(citation.abstract, keytermsRE)
    citation.keywords = citation.keywords && citation.keywords.map(k => markKeywords(k, keytermsRE))
  }
}

function markKeywords (text, keytermsRE) {
  return text && text.replace(keytermsRE, '<span class="keyterm">$&</span>')
}

module.exports = router
