import * as core from '@actions/core'
import * as github from '@actions/github'
import {createIssue, findCreatedIssueWithBodyPrefix, updateIssue} from './issue'
import {
  enablePullRequestAutoMerge,
  getPullRequest,
  listAvailablePullRequests,
  mergePullRequest,
  updateBranch
} from './pullRequest'
import {Condition, GhContext, IssueInfo, RecordBody} from './type'
import {getViewerName} from './user'
import {isPendingMergePr, isStatusCheckPassPr, stringify} from './utils'

async function run(): Promise<void> {
  try {
    const token = core.getInput('token')
    const autoMergeMethod = core.getInput('autoMergeMethod')
    const requiredApprovals = parseInt(core.getInput('requiredApprovals'))
    const requiredStatusChecks = core
      .getInput('requiredStatusChecks')
      .split('\n')
      .filter(s => s !== '')
    const requiredLabels = core
      .getInput('requiredLabels')
      .split('\n')
      .filter(s => s !== '')
    const condition: Condition = {
      requiredApprovals,
      requiredStatusChecks,
      requiredLabels
    }

    core.info('Condition:')
    core.info(stringify(condition))

    const octokit = github.getOctokit(token)
    const {owner, repo} = github.context.repo
    const ctx: GhContext = {octokit, owner, repo, autoMergeMethod}

    const viewerName = await getViewerName(ctx)
    const {recordIssue, recordBody} = await getRecordIssue(ctx, viewerName)
    if (recordBody.editing) {
      core.info('Other actions are editing record. Exit.')
      return
    }
    await updateRecordIssueBody(ctx, recordIssue, {
      ...recordBody,
      editing: true
    })

    let newIssueBody: RecordBody = {editing: false}
    try {
      newIssueBody = await maybeUpdateBranchAndMerge(ctx, recordBody, condition)
    } finally {
      await updateRecordIssueBody(ctx, recordIssue, newIssueBody)
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else if (typeof error === 'string') {
      core.setFailed(error)
    }
  }
}

async function maybeUpdateBranchAndMerge(
  ctx: GhContext,
  recordBody: RecordBody,
  condition: Condition
): Promise<RecordBody> {
  const availablePrs = await listAvailablePullRequests(ctx)
  // Get pending merge pr after all pr status become available
  const pendingMergePrNum = recordBody.pendingMergePullRequestNumber
  if (pendingMergePrNum !== undefined) {
    const pendingMergePr = await getPullRequest(ctx, pendingMergePrNum)
    if (isPendingMergePr(pendingMergePr, condition)) {
      if (
        pendingMergePr.mergeStateStatus === 'BLOCKED' ||
        pendingMergePr.mergeStateStatus === 'UNKNOWN'
      ) {
        core.info(`Wait PR #${pendingMergePrNum} to be merged.`)
        return {...recordBody, editing: false}
      } else if (pendingMergePr.mergeStateStatus === 'BEHIND') {
        await enablePullRequestAutoMerge(ctx, pendingMergePr.id)
        await updateBranch(ctx, pendingMergePrNum)
        core.info(
          `Update branch and wait PR #${pendingMergePrNum} to be merged.`
        )
        return {...recordBody, editing: false}
      }
    }
    core.info(
      `Pending merge PR #${pendingMergePrNum} can not be merged. Try to find other PR that needs update branch.`
    )
  }

  const passPrs = availablePrs.filter(pr => isStatusCheckPassPr(pr, condition))
  const cleanPr = passPrs.find(
    // Also allow UNSTABLE as we check via [isStatusCheckPassPr] and some checks maybe ignorable
    pr => pr.mergeStateStatus === 'CLEAN' || pr.mergeStateStatus === 'UNSTABLE'
  )
  if (cleanPr) {
    core.info(`Merge PR #${cleanPr.number}.`)
    await mergePullRequest(ctx, cleanPr.id)
    return {editing: false}
  }

  const behindPr = passPrs.find(pr => pr.mergeStateStatus === 'BEHIND')
  if (behindPr) {
    core.info(
      `Found PR #${behindPr.number} can be merged. Try to update branch and enable auto merge.`
    )
    await updateBranch(ctx, behindPr.number)
    await enablePullRequestAutoMerge(ctx, behindPr.id)
    return {
      editing: false,
      pendingMergePullRequestNumber: behindPr.number
    }
  }

  core.info('Found no PR that needs update branch.')
  return {editing: false}
}

async function updateRecordIssueBody(
  ctx: GhContext,
  recordIssue: IssueInfo,
  body: RecordBody
): Promise<void> {
  await updateIssue(ctx, {
    ...recordIssue,
    body: createIssueBody(body)
  })
}

async function getRecordIssue(
  ctx: GhContext,
  createdBy: string
): Promise<{recordIssue: IssueInfo; recordBody: RecordBody}> {
  let recordIssue = await findCreatedIssueWithBodyPrefix(
    ctx,
    createdBy,
    issueBodyPrefix
  )
  if (!recordIssue) {
    recordIssue = await createIssue(ctx, issueTitle)
  }
  const recordBody = parseIssueBody(recordIssue.body)
  return {
    recordIssue,
    recordBody
  }
}

function parseIssueBody(body: string): RecordBody {
  try {
    const json = body.split('```json').at(-1)?.split('```')?.at(0)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return JSON.parse(json!)
  } catch (e) {
    return {}
  }
}

function createIssueBody(body: RecordBody): string {
  return `
${issueBodyPrefix}
This issue provides [lcdsmao/update](https://github.com/lcdsmao/update-branch) status.

Status:

\`\`\`json
${stringify(body)}
\`\`\`
`
}

const issueBodyPrefix = '<!-- lcdsmao/update-branch -->'
const issueTitle = 'Update Branch Dashboard'

run()
