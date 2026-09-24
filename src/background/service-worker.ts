// Service worker entry point. The logic lives in ./index.ts; this file exists
// only so the entry chunk has a name distinct from src/content/index.ts (two
// emitted chunks both named "index.ts" made the bundler wire the service-worker
// loader to the wrong one — see DECISIONS.md).
import './index';
