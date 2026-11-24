// Which release the page's Linux links open (docs/website.md). The build
// writes this function's source into the page's script, and the tests call it.

/**
 * The newest published Linux preview in GitHub's list of releases: a
 * prerelease, not a draft, whose tag starts with `linux-`. GitHub does not
 * list one day's releases newest first (it put linux-test-0.2.1 ahead of
 * linux-0.2.2, published hours later the same day), so the newest is the one
 * published last, not the first in the list. Releases with no readable
 * publish time keep the list's order.
 */
export function newestLinuxPreview(list) {
  let newest = null;
  let newestAt = -1;
  for (const x of Array.isArray(list) ? list : []) {
    if (!(x && x.prerelease && !x.draft && /^linux-/.test(x.tag_name))) continue;
    const at = Date.parse(x.published_at) || 0;
    if (at > newestAt) { newest = x; newestAt = at; }
  }
  return newest;
}
