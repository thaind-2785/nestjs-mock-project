import { ApplicationException } from '../common/errors/application.exception';
import { hasDefinedUpdate, parseRoomVersionHeader } from './room-version';

describe('room optimistic version policy', () => {
  it('accepts only a quoted positive decimal If-Match value', () => {
    expect(parseRoomVersionHeader('"17"')).toBe('17');
    expect(parseRoomVersionHeader('"18446744073709551615"')).toBe(
      '18446744073709551615',
    );

    for (const value of [undefined, '17', '"0"', 'W/"17"', '"1", "2"']) {
      try {
        parseRoomVersionHeader(value);
        throw new Error('Expected invalid room version to be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationException);
        expect(error).toMatchObject({ errorCode: 'ROOM_VERSION_CONFLICT' });
      }
    }
  });

  it('distinguishes an empty patch from an explicit nullable update', () => {
    expect(hasDefinedUpdate({ name: undefined })).toBe(false);
    expect(hasDefinedUpdate({ viewCode: null })).toBe(true);
    expect(hasDefinedUpdate({ amenityIds: [] })).toBe(true);
  });
});
