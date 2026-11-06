import { Router } from 'express';
import { config } from '../../lib/config.js';

import accountRouter from './account.js';
import completeConsentRouter from './completeConsent.js';
import invitePreviewRouter from './invitePreview.js';
import oauthRouter from './oauth.js';
import passwordResetRouter from './passwordReset.js';
import profileRouter from './profile.js';
import registerRouter from './register.js';
import sessionRouter from './session.js';
import statusRouter from './status.js';

const router = Router();

// Account lifecycle endpoints are absent in the shared local household mode.
router.use((req, res, next) => {
  if (!config.localMode
    || (req.method === 'GET' && ['/status', '/me'].includes(req.path))
    || (req.method === 'PUT' && req.path === '/active-location')) return next();
  res.status(404).json({ error: 'NOT_FOUND', message: 'Accounts are disabled in local mode' });
});

// Mount order is incidental — none of the sub-routers share a path prefix or
// have overlapping verbs, so Express's first-match-wins doesn't kick in. The
// grouping below follows lifecycle order: discovery → signup → session →
// identity → password & account → social.
router.use(statusRouter);
router.use(invitePreviewRouter);
router.use(registerRouter);
router.use(sessionRouter);
router.use(profileRouter);
router.use(passwordResetRouter);
router.use(completeConsentRouter);
router.use(accountRouter);
router.use(oauthRouter);

export default router;
