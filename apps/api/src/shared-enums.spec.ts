import * as sharedEnums from '@ticketify/shared/enums';
import { apiErrorSchema } from '@ticketify/shared';
import * as prismaEnums from './generated/prisma/enums';

/**
 * packages/shared must mirror the Prisma enums exactly: same enum names, same members.
 * If this fails, update packages/shared/src/enums.ts together with schema.prisma.
 */
/** Exported names, minus the synthetic `default` that CJS→ESM interop adds to a namespace. */
const exportedNames = (namespace: object): string[] =>
  Object.keys(namespace)
    .filter((key) => key !== 'default')
    .sort();

describe('@ticketify/shared enums', () => {
  it('declares exactly the same enums as the Prisma schema', () => {
    expect(exportedNames(sharedEnums)).toEqual(exportedNames(prismaEnums));
  });

  it.each(Object.keys(prismaEnums))('%s has identical members', (name) => {
    const prisma = (prismaEnums as Record<string, unknown>)[name];
    const shared = (sharedEnums as Record<string, unknown>)[name];

    expect(shared).toEqual(prisma);
  });
});

describe('@ticketify/shared schemas', () => {
  it('can be required at runtime from the CommonJS API', () => {
    const body = {
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Not found',
      path: '/x',
      timestamp: '2026-11-01T00:00:00.000Z',
    };

    expect(apiErrorSchema.parse(body)).toEqual(body);
  });
});
