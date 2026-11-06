import { Router } from 'express';
import { config } from '../../lib/config.js';
import { authenticate } from '../../middleware/auth.js';
import crudRouter from './crud.js';
import inviteRouter from './invite.js';
import membersRouter from './members.js';
import statsRouter from './stats.js';

const router = Router();

router.use(authenticate);

// Each /:id sub-route has a distinct method+path, so mount order is not
// load-bearing today. Mounting crud last reserves it as the safety net for
// future literal additions that might otherwise collide with /:id.
if (!config.localMode) router.use(inviteRouter);
router.use(statsRouter);
if (!config.localMode) router.use(membersRouter);
router.use(crudRouter);

export default router;
