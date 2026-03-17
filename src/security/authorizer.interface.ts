/** @author Shuja naqvi */
import { OperationPrivilege } from './roles';

export default interface IAuthorizer {
  assertCanAccess(entityId: string, minimumPrivilege: OperationPrivilege): Promise<void>;
}
