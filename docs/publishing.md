# Publishing to the Chrome Web Store

## One-time setup

1. **Create the store item.** The Web Store API cannot create new items. Run `npm run package`, then upload `release/tailorscript-<version>.zip` once in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole). Fill in the listing with [store-listing.md](store-listing.md) and give <https://nevin.github.io/tailorscript/privacy.html> as the privacy policy URL. That page is `site/privacy.html`; keep it in step with [privacy-policy.md](privacy-policy.md).
2. **Enable the API.** In a Google Cloud project, enable the *Chrome Web Store API* and configure the OAuth consent screen.
3. **Create OAuth credentials.** Create an OAuth client ID and note the client ID and secret.
4. **Get a refresh token** for the `https://www.googleapis.com/auth/chromewebstore` scope, signed in as the account that owns the item. The [official guide](https://developer.chrome.com/docs/webstore/using-api) walks through this.
5. **Note the IDs.** The publisher ID is in the Developer Dashboard's account settings. The extension ID is the 32-character ID in the item's dashboard URL.
6. **Store the credentials.** For local releases, copy `.env.example` to `.env` (git ignores it) and fill it in. For CI, add the same five values as secrets in a GitHub environment named `chrome-web-store`; add required reviewers to that environment so every release needs an approval.

## Each release

```bash
npm version minor          # or patch / major; updates package.json and src/manifest.json
npm run release            # lint, tests, checks, then release/tailorscript-<version>.zip
npm run submit -- --dry-run --publish
npm run submit -- --publish
```

| Command | Effect |
| --- | --- |
| `npm run submit` | Uploads the package as a draft. Nothing is submitted for review. |
| `npm run submit -- --publish` | Uploads, then submits for review. It goes live when approved. |
| `npm run submit -- --publish --staged` | Uploads and submits; once approved it is staged, so you choose when to publish in the dashboard. |
| `npm run submit -- --status` | Shows the published and submitted revisions and the last upload state. |
| `--zip <path>` | Uploads a specific archive instead of the one for the current version. |

From GitHub, run the **Release to Chrome Web Store** workflow by hand and choose draft, review or staged.

## GitHub release and project page

After the version bump is on `main` and CI has passed, publish the same package on GitHub:

```bash
npm run release
gh release create v<version> release/tailorscript-<version>.zip release/tailorscript-<version>.zip.sha256 --title "Tailorscript <version>" --notes-file <notes>
```

Use that version's section of `CHANGELOG.md` as the notes. The project page at <https://nevin.github.io/tailorscript/> is the `site/` folder; the **Publish site** workflow deploys it whenever `site/` changes on `main`.

## Notes

- The script uses Chrome Web Store API v2. API v1.1 stopped working on 15 October 2026.
- The `userScripts` permission draws extra review. The justification in the store listing explains that scripts are written by the user, which is the case this API exists for.
- If you change the listing's visibility in the dashboard, publish once from the dashboard before the API can publish again.
