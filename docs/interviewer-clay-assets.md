# Adult clay interviewer assets

Updated on 2026-10-21. Five fixed adult identities are shared by Live, Chat, and saved answer history. The first three restore the earlier human-proportion 3D version requested by the user; two matching portraits extend the supported five-person panel. All PNGs retain their original RGBA transparency. No expression scoring is used. Live interviewer output animates only a local mouth patch using the original lip texture and the measured output RMS; quiet/static views retain the original PNG unchanged.

## Workspace assets and provenance

| Identity | Workspace asset | Source |
| --- | --- | --- |
| A: cream blazer, chestnut bob | `apps/web/public/images/interviewers/human-clay-a.png` | Restored unchanged from `C:/Users/MaYunsong/.codex/generated_images/01a158be-c13b-70d2-99c1-160d95ffee93/exec-c730bd71-6ac9-48fc-9b18-56bc55306508.png` |
| B: blue blazer, dark wavy hair, round glasses | `apps/web/public/images/interviewers/human-clay-b.png` | Restored unchanged from `C:/Users/MaYunsong/.codex/generated_images/01a158be-c13b-70d2-99c1-160d95ffee93/exec-97fa6c9a-abb0-4347-a946-dc4e562640fa.png`; matches the user's attached reference |
| C: lavender blazer, low bun | `apps/web/public/images/interviewers/human-clay-c.png` | Restored unchanged from `C:/Users/MaYunsong/.codex/generated_images/01a158be-c13b-70d2-99c1-160d95ffee93/exec-3243d579-acd7-44a5-9a6d-43c67079ae55.png` |
| D: sage blazer, salt-and-pepper hair | `apps/web/public/images/interviewers/human-clay-d.png` | Built-in `image_gen`, `transparent_background:true`, source `C:/Users/MaYunsong/.codex/generated_images/01a159b5-a066-7620-ba90-f6924d086cef/exec-14dd89bd-69de-4294-8996-6ed907910806.png` |
| E: peach blazer, shoulder-length hair, glasses | `apps/web/public/images/interviewers/human-clay-e.png` | Built-in `image_gen`, `transparent_background:true`, source `C:/Users/MaYunsong/.codex/generated_images/01a159b5-a066-7620-ba90-f6924d086cef/exec-b4f90a77-80cf-40fb-b0b9-3eddb978b6ec.png` |

The earlier toy-like `clay-a.png`–`clay-c.png` files are retained as unused history. Production references use the five `human-clay-*.png` files. The exact original prompts for restored A–C were not available in the asset files; no replacement generation was performed for them.

## Final new generation prompts

Each portrait was generated in its own built-in call and inspected before copying to the workspace. B was the style reference for D; C was the style reference for E. The reference was used for rendering style and framing, not to duplicate identity.

### D

Use case: stylized-concept. Asset type: transparent square interviewer portrait for a bright Korean study app. Reference image is ONLY a style, lighting and adult human proportion guide, not an identity to duplicate. Generate ONE distinct Korean male university interviewer, about 50 years old, short neat salt-and-pepper hair swept back, no glasses, friendly attentive expression and small relaxed smile, light sage green blazer over ivory shirt. Match reference premium soft clay 3D CGI: realistic adult facial proportions, sculpted full eyes with iris and eyelids, natural small nose and lips, subtly textured soft skin and individual sculpted hair strands, tactile but refined fabric. Front facing, eye-level camera, head and upper shoulder bust filling square, top of head fully in frame with a small transparent margin, both shoulders reach bottom edge. Warm diffuse studio lighting, bright approachable mood. True transparent background. No text, no frame, no props. Avoid toy proportions, dot eyes, oversized head, chubby baby cheeks, exaggerated cartoon features. Should belong to the same portrait family as the supplied reference but clearly a different person.

### E

Use case: stylized-concept. Asset type: transparent square interviewer portrait for a bright Korean study app. Reference image is ONLY a style, lighting and adult human proportion guide, not an identity to duplicate. Generate ONE distinct Korean female university interviewer, about 48 years old, neat straight black shoulder-length hair tucked behind one ear, thin oval warm brown glasses, friendly attentive expression with small confident smile, pale coral peach blazer over ivory shirt. Match reference premium soft clay 3D CGI: realistic adult facial proportions, sculpted full eyes with iris and eyelids, natural small nose and lips, subtly textured soft skin and individual sculpted hair strands, tactile refined fabric. Front facing, eye-level camera, head and upper shoulder bust filling square, top of head fully in frame with a small transparent margin, both shoulders reach bottom edge. Warm diffuse studio lighting, bright approachable mood. True transparent background. No text, no frame, no props. Avoid toy proportions, dot eyes, oversized head, chubby baby cheeks, exaggerated cartoon features. Should belong to the same portrait family as the supplied reference but clearly a different person.

## Recording setup persistence

The Live screen stores `liveRecordingConsent` and `liveCameraEnabled` in the authenticated student's existing `student_preferences.data` through the validated preference action. The saved state is restored from bootstrap data for subsequent rooms and devices. The optional recording-settings disclosure is collapsed after consent. No microphone access occurs on render or setting changes: a start gesture still triggers the real browser permission/device check.

The student can reopen settings and withdraw consent after pausing. Changing a connected device choice preserves the unfinished recording, releases tracks, and resets the controller's device-preparation cache. Existing recordings are not deleted by consent withdrawal. A failed consent save never enables recording, and pending saves block voice starts/re-recording. Text answers remain available without recording consent.

Validation: the five assets are distinct PNGs with RGBA alpha; stable mapping A–E and no reaction-driven face changes are covered. Live consent restoration/save failure/revocation and controller device-reset preservation are covered by executable regression tests.
