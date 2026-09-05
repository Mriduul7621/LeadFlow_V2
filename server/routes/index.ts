import { Router } from 'express';

import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import leadRoutes from './lead.routes';
import metadataRoutes from './metadata.routes';
import workflowRoutes from './workflow.routes';
import notificationRoutes from './notification.routes';
import dashboardRoutes from './dashboard.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/leads', leadRoutes);
router.use('/metadata', metadataRoutes);
router.use('/workflow', workflowRoutes);
router.use('/notifications', notificationRoutes);
router.use('/dashboard', dashboardRoutes);

export default router;