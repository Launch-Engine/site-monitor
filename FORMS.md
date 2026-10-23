# Forms

`forms.mjs` checks that every form on every site in `forms.json` reaches
where it must. Workflow `Forms` (`.github/workflows/forms.yml`):

| When | What | Sends anything? |
|---|---|---|
| Every hour | **Setup:** every live form (found on the site's pages) has a route in the site's `lib/forms.json`; Netlify collects it; every recipient is emailed (our sender, or a Netlify notification until our sender is live); monday's lead board, columns and Source labels exist; the workspace intake is set up; and no real form email failed in the last 2 hours. | No |
| 9 AM Denver | **Test:** one submission per form from a signed address (`forms-check+<time>.<sig>@launchengine.com`). Proves it is saved in Netlify Forms, the email goes out (SendGrid sandbox: accepted, never delivered), and a lead would be saved by the workspace (dry run, nothing kept). The test is then deleted. Skipped for any form where a Netlify notification still emails someone outside LaunchEngine. | No email reaches a person |
| 3 AM Denver | **Count:** every real submission of the last 26 hours shows as emailed in the site's delivery log, and every lead is in the workspace and in monday. | No |

Failures post to Slack #site-monitor with the form, the time and a masked
address. A real submission that missed a destination is still in Netlify
Forms: get it to the team, then fix the cause.

Each site provides `/.netlify/functions/form-status` (delivery log, setup,
received lookup; needs `FORM_CHECK_SECRET`), so client keys never leave the
site. Reference implementation and routing table: `Launch-Engine/site-falconco`
`FORMS.md`.

Secrets here: `NETLIFY_AUTH_TOKEN`, `FORM_CHECK_SECRET` (same value as each
site's env), `SLACK_ALERT_WEBHOOK_URL`.

By hand: `/forms-check` in Claude Code, or
`node forms.mjs [site] [--test|--count]` (`FORMS_URL=` for a deploy preview).
