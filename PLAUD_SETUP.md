# Plaud Embedded demo setup

BUEELD remains a website. A temporary iPhone bridge uses Plaud Embedded to pair the borrowed NotePin S, sync audio, and upload it to Plaud storage with a user token. The bridge sends Plaud's short-lived signed audio URL to BUEELD. The BUEELD server creates the transcription task under the paired account, polls Plaud, and stores timestamped segments. A founder must select an exact quote and confirm the learning before `field_observations` advances.

## 1. Developer portal and private credentials

1. In [Plaud Developer Portal](https://portal.plaud.ai), create an **Embedded SDK Application**. Copy its **Client ID** and **Secret Key** into the BUEELD server environment as `PLAUD_CLIENT_ID` and `PLAUD_CLIENT_SECRET`.
2. In **App Settings → API Keys**, create an API key and set `PLAUD_API_KEY` in the BUEELD server environment. Keep all three values private; `.env` is gitignored. Do not paste them into an issue, chat, or commit.
3. Restart the BUEELD server and check `GET /api/plaud/status` returns `{"configured":true}`. This only confirms that all three variables are present; it does not prove Plaud accepted them.

Plaud's [quickstart](https://docs.plaud.ai/plaud-embedded/quickstart) explains these credentials. The server exchanges Client ID and Secret Key for a partner token and mints a [user token](https://docs.plaud.ai/plaud-embedded/auth-api-overview) tied to the BUEELD account. The server alone uses the API key to [submit audio](https://docs.plaud.ai/api-reference/transcription-api/submit-audio-for-transcription) and [retrieve the resulting task](https://docs.plaud.ai/api-reference/transcription-api/get-transcription-task).

## Manual SRT fallback for a website demo

If the temporary iPhone bridge is unavailable, open the recording in [Plaud Web](https://web.plaud.ai), choose **Share → Export → Transcript → SRT** with timestamps, and download the file. [Plaud documents SRT transcript export](https://support.plaud.ai/hc/en-us/articles/51023259082393-Export-recordings-transcripts-and-summaries). In BUEELD, sign in to Lab, open Sources → Plaud, and use **Import a Plaud Web transcript (.srt)**. The website accepts a UTF-8 `.srt` file up to 160 KB with at most 2000 timestamped segments. After importing, select an exact quote and confirm the real interview and your learning, just as with an Embedded transcript.

This route stores a **user-supplied file** under the Lab account. BUEELD cannot prove that the file came from Plaud or a NotePin S. The list, detail view, and saved evidence label it as a manual Plaud SRT export. It is not an Embedded SDK ingestion or evidence of an SDK bonus on its own. The file contents stay in the account-bound private transcript store and are removed when that account is deleted.

## 2. Connect the temporary iPhone bridge

Build the patched Plaud starter using [the companion README](plaud-ios/README.md) and its [step-by-step iPhone guide](plaud-ios/BUEELD-INTEGRATION.md). The patch targets a fixed upstream commit; it is not a prebuilt App Store app. The bridge retrieves its Plaud user token at runtime from pairing. No Plaud API key, Client Secret, or static user token belongs in the iPhone app or its configuration files.

1. Serve BUEELD over **HTTPS** on a URL reachable from the iPhone. Sign in to the BUEELD website, open Sources → Plaud, and choose **Connect iPhone**. The website displays a one-time, case-sensitive 12-character code that expires after 10 minutes.
2. Open the temporary Plaud iOS bridge on the physical iPhone. Enter the BUEELD site URL and pairing code. The bridge exchanges the code for a Plaud user token and a BUEELD ingest token; it stores the user token in the iPhone Keychain. The site does not send its login cookie or CSRF token to the bridge.
3. Pair the borrowed NotePin S in this bridge, record an interview with the participant's agreement, and sync and upload the audio. The bridge submits Plaud's signed download URL and basic recording metadata to BUEELD; it sends neither raw audio nor transcript text to BUEELD. BUEELD starts Plaud transcription and shows the task as pending. Refresh Sources → Plaud until it succeeds, then read the timestamped transcript, select an exact quote, write the learning, and confirm it as real field evidence.

The borrowed device should be bound through this Embedded bridge, not a separate consumer Plaud account. Plaud's [iOS starter guide](https://docs.plaud.ai/plaud-embedded/ios-starter-app) requires a physical iPhone and explains that the device must be **unbound before uninstalling the bridge or returning the device**. In the bridge's Settings, request unbind and wait for confirmation; because the cloud unbind can be asynchronous, verify the remote [device binding state](https://docs.plaud.ai/api-reference/device-binding-api/get-device-binding) or have the Plaud stand confirm it. Retry before returning the loaner if it still appears bound.

## Source provenance and demo limits

The server accepts only an unexpired signed HTTPS audio URL on the Plaud S3 host documented by Plaud (`plaud-bucket.s3.amazonaws.com`). If a real Plaud upload returns a different host, inspect its **hostname only** and add that exact host to the server's comma-separated `PLAUD_DOWNLOAD_HOSTS`; do not add a wildcard or paste the full signed URL into documentation. The server creates and owner-binds the task before polling it. The signed URL is supplied by the paired iPhone and serves as a bearer capability; the Plaud transcription result alone does not prove that the audio came from the NotePin S or from a particular interviewee. The founder confirms the real-world source before a milestone advances.

The code and local tests do not establish that portal access, device pairing, upload, transcription, or deployment work with this particular borrowed NotePin S. Complete one physical end-to-end run before the hackathon demo.
