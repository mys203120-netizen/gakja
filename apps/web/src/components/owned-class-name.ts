import layout from '@/styles/layout.module.css';
import brand from '@/styles/brand.module.css';
import dialogs from '@/styles/dialogs.module.css';
import feedback from '@/styles/feedback.module.css';
import shell from '@/styles/shell.module.css';
import marketing from '@/styles/marketing.module.css';
import auth from '@/styles/auth.module.css';
import admin from '@/styles/admin.module.css';
import learning from '@/styles/learning.module.css';
import interview from '@/styles/interview.module.css';
import assistant from '@/styles/assistant.module.css';
import training from '@/styles/training.module.css';
import schools from '@/styles/schools.module.css';
import resources from '@/styles/resources.module.css';
import controls from '@/styles/controls.module.css';
import {createOwnedClassResolver} from '@/lib/owned-class-resolver';

/** DOM hooks stay readable for navigation/GSAP; aliases give each style one owner.
 * This fixed import order is shared by every route, including portal contents. */
export const ownedClassName=createOwnedClassResolver([layout,brand,dialogs,feedback,shell,marketing,auth,admin,learning,interview,assistant,training,schools,resources,controls]);
