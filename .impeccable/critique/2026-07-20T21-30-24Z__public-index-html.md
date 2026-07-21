---
target: public/index.html — hosted companion gate
total_score: 16
p0_count: 0
p1_count: 3
timestamp: 2026-07-20T21-30-24Z
slug: public-index-html
---
# CMUX3D connection gate critique

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 1 | Hollow dot and static copy do not identify disconnected, searching, failed, or ready. |
| 2 | Match system / real world | 1 | HerdR, Pi, localhost, and companion arrive before plain-language orientation. |
| 3 | User control and freedom | 2 | Three exits exist, but their differences are unexplained. |
| 4 | Consistency and standards | 3 | Native dialog, links, and button are conventional. |
| 5 | Error prevention | 1 | The primary button invites a connection attempt that cannot start a missing companion. |
| 6 | Recognition rather than recall | 1 | Users must infer what setup, secure link, and localhost mean. |
| 7 | Flexibility and efficiency | 1 | No automatic detection or clear retry path is visible. |
| 8 | Aesthetic and minimalist design | 2 | The modal is clean, but the huge inert workspace makes it feel broken. |
| 9 | Error recovery | 2 | Code later changes the CTA to “Open locally,” but the initial state does not expose a recovery model. |
| 10 | Help and documentation | 2 | Setup exists as a link, not contextual guidance. |
| **Total** |  | **16/40** | **Poor** |

## Anti-Patterns Verdict

**LLM assessment:** It does not trip obvious AI-decoration tells. The failure is product strangeness: a technically correct trust boundary is presented as a tiny, ambiguous decision card over a disabled application.

**Deterministic scan:** 0 findings in `public/index.html`. The detector correctly found no banned visual scaffold; it cannot detect the contradictory workflow or unclear hierarchy.

**Visual evidence:** Headless Chrome captured the deployed page at 1440×1000. The screenshot and five bound callouts are on the tldraw page **CMUX3D gate critique**.

## Overall Impression

The security boundary is legitimate and the dialog implementation is restrained. The page still feels absurd because it asks users to resolve architecture before it tells them the one thing to do.

## What’s Working

- The native modal, focus treatment, and live status output are sound accessibility primitives.
- “Terminals and files remain on this machine” is useful reassurance.
- The gate avoids decorative onboarding clutter.

## Priority Issues

### [P1] The primary action contradicts the instruction
**Why it matters:** “Connect companion” implies the page can perform the missing launch; the next line admits the user must start CMUX3D elsewhere.
**Fix:** Make the CTA match the detected state: launch/open, retry, or connected—not a generic connect action.
**Suggested command:** `$impeccable clarify`

### [P1] Three routes compete without a decision model
**Why it matters:** Connect, setup, and localhost look like peer choices although they represent different lifecycle states.
**Fix:** Present one state-specific next action; keep setup as secondary help and remove localhost as a peer option unless it is the intended primary route.
**Suggested command:** `$impeccable distill`

### [P1] Connection status is not legible
**Why it matters:** The hollow dot and static sentence do not explain whether detection is running, failed, or waiting for the local app.
**Fix:** Name the current state and expose one recovery action.
**Suggested command:** `$impeccable harden`

### [P2] Architecture appears before orientation
**Why it matters:** HerdR and Pi are meaningful to the implementation, not to a first-time user deciding what to click.
**Fix:** Explain the companion’s purpose in one plain sentence; reveal trust-boundary detail afterward.
**Suggested command:** `$impeccable clarify`

### [P2] The blocked workspace dominates the composition
**Why it matters:** The huge near-black cube and ghost controls make the product look failed or empty rather than intentionally gated.
**Fix:** Give the connection state ownership of the screen, or keep the workspace legible enough to communicate the value waiting behind it.
**Suggested command:** `$impeccable layout`

## Cognitive Load

High (4/8 failures): visual hierarchy, one-thing-at-a-time, recognition, and progressive disclosure fail. The visible choice count is only three, but each choice requires technical inference.

## Emotional Journey

The first peak is a block before any demonstrated value. The reassuring local-data sentence helps, but the ending is an unresolved choice among connect, setup, and localhost.

## Persona Red Flags

- **Jordan, first-timer:** Cannot distinguish companion setup from localhost and meets HerdR/Pi before understanding the companion.
- **Alex, power user:** Sees an avoidable click where automatic detection and state-specific retry should exist.
- **Sam, accessibility-dependent:** Benefits from native dialog semantics and focus, but the aria-hidden status dot carries no useful state and the live text starts as static instruction rather than connection feedback.

## Minor Observations

- “Your six shells” assumes sessions already exist and belong to the user.
- “Secure link” is unexplained and therefore not reassuring.
- Equal left/right placement makes the two secondary links look equally recommended.

## Questions to Consider

- If the secure link is the normal path, why is this a choice screen rather than a status screen?
- Which state is most common: first install, app not running, or expired/missing pairing token?
- Should the hosted surface sell the spatial workspace before asking users to install anything?
