/** @author Shuja naqvi */
import { isNull, isUndefined } from 'lodash';

export const isDefined = (value: unknown): boolean =>
  !isUndefined(value) && !isNull(value);
