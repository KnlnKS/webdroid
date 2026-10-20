/** MotionEvent's actions; POINTER_DOWN and POINTER_UP carry the changed pointer's index from bit 8 */
export const ACTION_DOWN = 0, ACTION_UP = 1, ACTION_MOVE = 2, ACTION_CANCEL = 3, ACTION_POINTER_DOWN = 5, ACTION_POINTER_UP = 6;
/** a touch pointer: its Android pointer id and display position */
export type TouchPointer = { id: number; x: number; y: number };
/** one MotionEvent: the action (POINTER_DOWN/UP with the changed pointer's index) and every pointer
 *  down, in ascending id order as InputReader lists them */
export type PointerSample = { action: number; pointers: TouchPointer[] };

export function queuePointer(pending: PointerSample[], sample: PointerSample): void {
  const last = pending[pending.length - 1];
  if (sample.action === ACTION_MOVE && last?.action === ACTION_MOVE) pending[pending.length - 1] = sample;
  else pending.push(sample);
}
