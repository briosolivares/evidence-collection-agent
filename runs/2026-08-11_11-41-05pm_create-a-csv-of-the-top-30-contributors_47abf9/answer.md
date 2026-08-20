# Top 30 Contributors to OpenClaw GitHub Repository

## Deliverable
See `top_30_contributors.csv` for the requested CSV with columns:
`github_handle, name, linkedin_url`

## Methodology
1. Started on the OpenClaw GitHub repo (https://github.com/openclaw/openclaw), as provided by the initial page context.
2. Navigated to the repo's Contributors insights page: https://github.com/openclaw/openclaw/graphs/contributors
3. Scrolled through the ranked contributor list (ranked by number of commits, as displayed by GitHub, in descending order) and recorded the top 30 GitHub handles in their displayed rank order:
   steipete, vincentkoc, shakkernerd, obviyus, github-actions[bot], joshavant, RomneyDa, claude,
   clawsweeper[bot], Alix-007, fuller-stack-dev, giodl73-repo, zhangguiping-xydt, Takhoffman,
   jalehman, mushuiyu886, Patrick-Erichsen, pgondhi987, yetval, ZengWen-DT, openclaw-clownfish[bot],
   IWhatsskill, qingminglong, TurboTheTurtle, vyctorbrzezowski, hugenshen, jesse-merhi,
   masatohoshino, zenglingbiao, cursoragent.
4. For each handle, visited the individual GitHub profile page (https://github.com/<handle>) and recorded:
   - `name`: the GitHub profile display name (falls back to the handle itself if the account has no separate display name, e.g. bot accounts or accounts that never set one).
   - `linkedin_url`: the LinkedIn URL listed on the GitHub profile's public "social links" section, if present. Left blank where no LinkedIn link was published on the profile.

## Notes
- Several of the top-30 slots are automation/bot accounts (`github-actions[bot]`, `clawsweeper[bot]`, `openclaw-clownfish[bot]`, `claude`, `cursoragent`) that appear in the repo's contributor graph because they authored commits (e.g., CI bots, AI coding agents). These do not have LinkedIn profiles; their `name` field reflects the GitHub display name shown on their profile page.
- Most human contributors did not have a LinkedIn URL published on their GitHub profile; those rows have an empty `linkedin_url` field.
- Row order in the CSV matches the contributor rank order shown on the GitHub Contributors graph (#1 = steipete down to #30 = cursoragent).
