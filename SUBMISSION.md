# Hackathon submission record and demo script

**Project:** Bueeld Lab — AI Co-Founder

**Tagline:** Give a startup idea real context, turn Lia's advice into a human-approved next mission, and bring evidence back.

**Track:** Make It — Build the product

**Team:** Maxime Gillot (human founder, product direction and final decisions) + Lia through AdaL (AI co-founder for conversation, source reasoning, and next-mission planning).

**Sponsor used:** AdaL. It contributed to the decision schema and implementation review. At runtime it produces live chat replies, sourced project analysis, structured decision plans, and reassessments. The demo uses an existing ChatGPT subscription connected to AdaL through OAuth; no new paid AdaL subscription was started.

**Short description:** Bueeld helps incubators turn scattered founder updates into context and a human-approved next mission. Bueeld Lab makes that loop conversational. A founder can start with an idea or analyze manually supplied project text and a public GitHub README. Lia cites the supplied material, separates facts from assumptions, identifies the main risk, and proposes one action with the evidence needed to judge it. The founder selects summaries for chat, reviews and edits a focused mission excerpt before pinning, approves the mission locally, and records evidence in a compact tracker. The code supports separate read-only OAuth connections for Gmail, Drive, Calendar, and Notion, with account-specific item selection. On the current temporary tunnel these four cards report `configured:false` because no stable callback origin or OAuth credentials are configured, so the demo uses sample data, local files, and public GitHub. The prototype does not execute outside actions.

## First-run path

The welcome screen places **Create a Lab account** above the starters. After signup, the founder answers one short question at a time in chat: new idea or existing project, audience, evidence, then obstacle and desired next move. Suggested answers, free text, Back, and Skip are available. The final structured brief triggers one AdaL reply that proposes a first mission; setup itself does not consume AI calls. Signed-in conversations and mission history autosave. Under the composer, the save row shows **Saving to Lab…**, **Saved to Lab**, or **Lab save failed** with **Retry save**. **New chat** saves the current signed-in chat and opens a blank one without a discard prompt; it keeps the chat if saving fails. A hidden guest draft presents explicit **Restore draft** and **Start fresh** choices, and is copied into an account only by explicit save.

## Demo outline, about 90 seconds

1. On the welcome screen point out **Create a Lab account** above the starters, then choose **Analyze a project**. **Sources** opens with connector cards first; scroll to **Analyze fictional workspace with Lia**. State that Atelier Loop and all four dated records are sample data.
2. Show the analysis card: source IDs, cited facts, main risk, proposed action, and expected evidence. Expand **View cited evidence** for assumptions and open questions. Select **Use this summary in chat** and click **Discuss selected sources with Lia**.
3. On Lia's latest response choose **Make a mission**, then **Pin as next mission**. Review or edit the focused excerpt in the pin field before choosing **Pin proposed mission**; if no excerpt is isolated, write one concrete action. Show that the founder, not Lia, chooses **Approve**.
4. Open **Missions**. Show the compact current mission, **Add evidence** after approval, collapsible full details, and history. Enter a clearly fictional result and leave it marked as demo evidence; do not present Lab points or maturity as verified traction. **Bring evidence** or **Discuss with Lia** prepares a chat follow-up without sending it.
5. If time permits, start **New chat** before showing **Describe an idea** / **Work on Bueeld** as the direct Bueeld path. For a signed-in tester, the previous chat saves and the blank chat opens without a discard prompt. The optional **Decision canvas** is a separate structured human checkpoint.

**Demo data disclosure:** The Atelier Loop email, notes, event, decision, interviews, expressions of interest, and sample metrics are fictional. They are not Bueeld traction. Citation labels trace supplied excerpts; they do not verify the claims independently.

**Source scope:** Gmail, Google Drive, Google Calendar, and Notion have per-tester read-only OAuth flows in code. Their live status is shown by `/api/connectors/status`; Google setup and real-account authorization still need verification before the Google connectors can be claimed as working for public visitors. [OAuth setup](OAUTH_SETUP.md) specifies the stable origin, callbacks, provider clients, and scopes. The demo accepts `.txt`, `.md`, `.csv`, `.json`, `.eml`, and `.ics` files up to 64 KB, plus text-based PDFs up to 8 MB (12 pages, 8,000 extracted characters). Image-only scans need OCR; DOCX is unsupported. Public GitHub analysis reads repository metadata and README only. Full analysis cards stay in page memory. Selected summaries accompany chat; the signed-in active conversation automatically hydrates up to three on reload, while guest source selections are lost. Guest drafts stay in browser storage until explicitly copied and saved. Authenticated mission history syncs per account. Raw provider text and OAuth tokens are not persisted on the server, though selected excerpts are sent to AdaL for the requested analysis. Source-derived content written into a saved chat remains in that saved conversation until the user deletes it.

## Lab accounts

An optional demo account lets a founder return to prior chats and mission history. After signup, chat-based guided setup leads to one AdaL mission proposal. The server stores only e-mail, a salted scrypt password hash, autosaved conversations (including partial onboarding answers), selected source summaries, and mission records in a private Git-ignored `.data` file. Sessions are short-lived; there is no e-mail verification or password recovery. The tester can delete the account and its stored chats/history from the account panel after confirming the password. Testers should use a unique password, never their Bueeld password. The composer’s **Connectors** shortcut jumps to source cards; provider OAuth still requires a stable configured origin.

**Quota and disclosure:** `GET /api/demo/usage` reports the shared AdaL allowance of 1,000 calls by default; chat and source analyses both spend from it. `MAX_AI_CALLS` can set a different cap. **Privacy & AI use** shows calls remaining. At two or fewer, a visible low-quota alert appears; at zero, new AI requests stop while saved chats and missions remain readable.

## Submission status

- **Crewbase submission:** recorded.
- **Git repository:** [private GitHub repository](https://github.com/MaximeGillot5/bueeld-cofounder-decision-loop). Reviewer access must be granted separately; the public GitHub analyzer cannot read it.
- **Live app URL:** temporary approved Cloudflare Quick Tunnel. The specific URL is recorded on the Crewbase project once validated; availability depends on the local processes staying open. It has a shared 1,000-call AdaL cap by default. OAuth requires a stable registered callback origin; Google account connections have not been verified live.
- **Demo video URL:** [Watch the demo](https://drive.google.com/file/d/1h4LcXX0j-Ztt9gWjE2fRfmXAxBnMz0R6/view?usp=drivesdk) — added to the Crewbase submission and available to anyone with the link (viewer). A 3m38 silent screen recording of the live application and AdaL responses, covering signup, chat, mission approval, reassessment, and session persistence using the clearly fictional Slotwise scenario.

## Feedback to collect

1. Did Lia distinguish a sourced claim from a verified outcome and a founder assumption?
2. Is the proposed mission specific enough to act on and collect evidence for?
3. Did the human approval and evidence loop change the recommendation when it should?
