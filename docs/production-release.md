# Production releases

Git changes and production releases are separate operations. The `vegapunk-albertsons` Vercel project's connection to `tomstello/vegapunk-app` was removed on October 2, 2026 at Tom's request following Jeffrey's September 29 recommendation. The signed-in project Git settings confirmed that the project was no longer connected. No deploy hooks were configured. This change preserves the running deployment and project settings, but branch-specific overrides must be checked before the next manual release.

`vercel.json` also sets `git.deploymentEnabled: false`. This prevents Git-triggered deployments for commits containing that configuration if a project is connected again. The independently managed project disconnection is the stronger separation: someone who can edit the repository could also change a repository file. CI performs validation only and has no deployment credentials.

## Current baseline and authority

- Project: `vegapunk-albertsons`, Vercel scope `thcostello1-9412s-projects`.
- Project ID: `prj_w3ZCz29JieC4f2EBP3IeMeshHWWW`.
- Deployment observed before disconnect: `2cEr9G19ntXtF1LFzJr7zy2jmVsn`, shown Ready, created by `jlicht-7142` on October 1, from commit `e8deacc3ecfc6904fb157d8b75eb233c267d8823`.
- [Project Git settings](https://vercel.com/thcostello1-9412s-projects/vegapunk-albertsons/settings/git).
- [Baseline deployment](https://vercel.com/thcostello1-9412s-projects/vegapunk-albertsons/2cEr9G19ntXtF1LFzJr7zy2jmVsn).

Use a named release operator with existing Vercel project access. Record Tom's research-policy approval and the responsible operator's technical acceptance with each release; confirm the institutional accountable owner separately. No new Vercel role or permission was granted by this change. GitHub branch rules and formal institutional change-control acceptance are separate controls; do not claim they exist merely because this document or CI exists.

## Review and validate a specific commit

1. Review the PR and identify the exact commit to release. Use a clean checkout at that commit; record `git rev-parse HEAD` and verify `git status --porcelain` is empty. Do not deploy uncommitted local files.
2. Use Node 22 and the committed lockfile. Run `npm ci --ignore-scripts`, `npm run check`, `npm test`, and a production build with the intended exact `PUBLIC_QUALTRICS_PARENT_ORIGINS`. CI uses a synthetic origin only to validate compilation; it cannot establish production origin settings.
3. For a redaction-policy change, run the current synthetic detector evaluation separately against the primary and fallback models using the authorized study key and approved test environment. Review misses, false positives and preserved-year/age controls. Unit tests mock extraction and cannot establish actual model recall. Keep prior benchmark results tied to their prior prompt/configuration.
4. Save the non-secret output of `npm run --silent v2:config-manifest`. Confirm all three arms and their immutable versions/hashes. Update each Qualtrics integration's `expectedConfigVersion` to the matching arm's version; record and verify the server-returned `configHash` against the manifest. Do not add an `expectedConfigHash` field to the strict parent-handshake contract. Check the documented policy change, provider allowlist, retention restrictions and checkpoint settings.

## Stage and promote deliberately

These are operator instructions, not commands executed by CI. Use the official Vercel CLI with its normal sign-in flow; do not paste bearer tokens into shell commands or commit environment files. The CLI must be linked to the existing project above, not a newly created project.

1. From the clean approved checkout, use `vercel link --scope thcostello1-9412s-projects --project vegapunk-albertsons` and verify the linked project identity before any deployment.
2. Confirm the Production environment values in the project, including all exact Qualtrics/vanity parent origins, the authorized OpenRouter account, enabled checkpoint backend, IAM/OIDC configuration, and log drain. Check any prior branch-specific overrides explicitly now that the Git connection is removed.
3. Create a staged production build without assigning production domains:

   ```sh
   vercel deploy --prod --skip-domain --scope thcostello1-9412s-projects
   ```

   Record the returned deployment URL/ID and source commit. This operation uses production environment values and may access production services; use only approved synthetic test identifiers and account for test records. It does not by itself update live Qualtrics configuration pins.

4. Validate the staged deployment using a separately controlled test survey/embedding with the matching `expectedConfigVersion`. Verify the returned configuration hash. Confirm new sessions for flu/COVID/combined, privacy failure behavior, stored screened transcript, return visits and the vanity-origin path. Coordinate the server deployment and the three Qualtrics version pins so participant pages never require a configuration unavailable on the assigned production deployment.
5. Record approval to promote and pause enrollment/new chat starts for a maintenance window. A new-session request uses the active server revision even when the old survey requests v12, so neither publishing v13 survey pins first nor promoting the server first is safe for uninterrupted new starts. While new starts are paused, promote that exact deployment through the Vercel dashboard or the documented `vercel promote` command, apply/publish the coordinated Qualtrics integration changes, and verify each live arm. Reopen new starts only when all three arms pass. Existing v12 sessions retain their immutable resume configuration. Do not substitute a different local checkout or create another unreviewed build.
6. Save a release record: approver/operator, UTC time, commit SHA, deployment ID, three config versions/hashes, survey publication versions, verification results and rollback target. Confirm Git settings remain disconnected.

## Rollback

Record the currently working production deployment and survey configuration pins before release. If acceptance fails, pause enrollment/new chat starts and use Vercel Instant Rollback to the recorded working deployment, coordinated with the prior three Qualtrics pins. Existing older session revisions remain immutable in the application; removing versions or rewriting their hashes is not a rollback mechanism. A deployment created before v13 cannot satisfy a survey pinned to v13 or resume a v13 session; account for any v13 sessions already started when choosing the recovery plan. Recheck all three arms before reopening new starts and record the reason.

Provider references: [Git-triggered deployment configuration](https://vercel.com/docs/project-configuration/git-configuration), [Vercel deploy](https://vercel.com/docs/cli/deploy), [promoting deployments](https://vercel.com/docs/deployments/promoting-a-deployment).
