import { auth } from '../auth';
import { actorFromSession } from './actor';

export { actorFromSession } from './actor';

export async function currentActor() {
  return actorFromSession(await auth());
}
