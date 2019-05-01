import * as Os from 'os'
import * as Path from 'path'
import * as FSE from 'fs-extra'

import { git } from './core'

import { Repository, WorkTreeSummary } from '../../models/repository'

/** Enumerate the list of work trees reported by Git for a repository */
export async function listWorktrees(
  repository: Repository
): Promise<ReadonlyArray<WorkTreeSummary>> {
  const result = await git(
    ['worktree', 'list', '--porcelain'],
    repository.path,
    'listWorkTrees'
  )

  const worktrees = new Array<WorkTreeSummary>()

  let match: RegExpMatchArray | null = null

  // the porcelain output from git-worktree covers multiple lines
  const worktreeRegex = /worktree (.*)\nHEAD ([a-f0-9]*)\n(branch .*|detached)\n/gm

  while ((match = worktreeRegex.exec(result.stdout)) !== null) {
    if (match.length !== 4) {
      log.debug(
        `[listWorkTrees] match '${
          match[0]
        }' does not have the expected number of groups. Skipping...`
      )
      continue
    }

    const path = match[1]
    const head = match[2]

    worktrees.push({ path, head })
  }

  return worktrees
}

/** Create a new work tree at the desired location on disk */
export async function addWorkTree(
  repository: Repository,
  path: string,
  commit: string
): Promise<WorkTreeSummary> {
  await git(
    ['worktree', 'add', '-f', path, commit],
    repository.path,
    'addWorkTree'
  )

  // because Git doesn't give enough information from stdout here I'm gonna
  // just enumerate things and find the new folder
  //
  // siiiiigh

  const workTrees = await listWorktrees(repository)

  const directoryName = Path.basename(path)
  const workTree = workTrees.find(t => Path.basename(t.path) === directoryName)

  if (workTree == null) {
    throw new Error(
      `[addWorkTree] Unable to find created worktree at path ${path}`
    )
  }

  return workTree
}

/** Cleanup the temporary worktree at a given location */
export async function removeWorkTree(
  repository: Repository,
  path: string
): Promise<void> {
  await git(
    ['worktree', 'remove', '-f', path],
    repository.path,
    'removeWorkTree'
  )
}

const DesktopWorkTreePrefix = 'github-desktop-worktree-'

function getTemporaryDirectoryPrefix() {
  return Path.join(Os.tmpdir(), DesktopWorkTreePrefix)
}

async function findTemporaryWorkTrees(repository: Repository) {
  const workTrees = await listWorktrees(repository)

  // always exclude the first entry as that will be "main" worktree and we
  // should not even look at it funny
  const candidateWorkTrees = workTrees.slice(1)

  return candidateWorkTrees.filter(t => {
    // NOTE:
    // we can't reliably check the full path here because Git seems to be
    // prefixing the temporary paths on macOS with a `/private` prefix, and
    // NodeJS doesn't seem to include this when we ask for the temporary
    // directory for the OS
    const directoryName = Path.basename(t.path)
    return directoryName.startsWith(DesktopWorkTreePrefix)
  })
}

/**
 * Lookup or create a new temporary work tree for use in Desktop without
 * touching the user's current repository state.
 */
export async function findOrCreateTemporaryWorkTree(
  repository: Repository,
  commit: string
): Promise<WorkTreeSummary> {
  const temporaryWorkTrees = await findTemporaryWorkTrees(repository)

  if (temporaryWorkTrees.length === 0) {
    const tmpdir = getTemporaryDirectoryPrefix()
    const directory = await FSE.mkdtemp(tmpdir)
    const workTree = await addWorkTree(repository, directory, commit)
    return workTree
  }

  const worktreeForDesktop = temporaryWorkTrees[0]

  await git(['checkout', commit], worktreeForDesktop.path, 'checkoutWorkTree')

  return worktreeForDesktop
}

/** Enumerate and cleanup any worktrees generated by Desktop */
export async function cleanupTemporaryWorkTrees(
  repository: Repository
): Promise<void> {
  const temporaryWorkTrees = await findTemporaryWorkTrees(repository)

  for (const worktree of temporaryWorkTrees) {
    await removeWorkTree(repository, worktree.path)
  }
}
