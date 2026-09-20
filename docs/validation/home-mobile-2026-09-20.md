# Home mobile audit — September 20

Read-only headless Chrome audit of the existing local-real pilot home at `http://127.0.0.1:3020/`. No wallet, POST, assessment, provider or chain action was made. Each run loaded seven local GET resources, all HTTP 200; no failed resource was observed. Screenshots were inspected alongside computed geometry.

| Viewport / theme | Guidance font | Guidance width | CTA font / target height | Horizontal overflow |
| --- | --- | --- | --- | --- |
| 320×844 / light | 8.215px | 257.28px | 16px / 44px | None |
| 390×844 / dark | 10.385px | 325.25px | 16px / 44px | None |
| 1280×900 / dark | 16px | 501.34px | 16px / 44px | None |

The approved one-line rule is preserved by shrinking mobile guidance. That is a genuine readability issue, not a passing accessibility result. A nonblocking user decision was requested: keep desktop one-line but allow sentence-boundary wrapping at 16px on narrow screens, or retain one line everywhere. No guidance/slogan CSS was changed during this audit.

Temporary screenshot evidence: `/private/tmp/sg-home-audit.U584ds/home-320-light.png`, `home-390-dark.png`, `home-1280-dark.png`. These temporary files are not portable CI artifacts. E13's separate wallet-dialog matrix and keyboard tests are documented in `docs/wallet-support.md`. Full E14 screen-reader, physical-device and contrast audit remains open.
