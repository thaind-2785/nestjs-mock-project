import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Module, type INestApplication, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';

type PropertySchema = NonNullable<
  NonNullable<OpenAPIObject['components']>['schemas']
>[string];

@Module({})
class EmptyModule {}

const sourceRoot = join(__dirname, '..', '..');

function dtoFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return dtoFiles(path);
    return entry.name.endsWith('.dto.ts') ? [path] : [];
  });
}

function dtoClasses(): Type[] {
  return dtoFiles(sourceRoot).flatMap((file) =>
    Object.values(jest.requireActual<Record<string, unknown>>(file)).filter(
      (value): value is Type => typeof value === 'function',
    ),
  );
}

/**
 * A `string | null` property reflects as `Object`, so without an explicit `type` Swagger
 * documents it as an empty object and the "Try it out" body sends `{}` - which the
 * `@IsString()` validator then rejects. A real object property always says what is in it.
 */
// A free-form map such as an error's `details` documents its shape by example instead.
function isObjectExample(example: unknown): boolean {
  return typeof example === 'object' && example !== null;
}

function isShapelessObject(schema: PropertySchema): boolean {
  if ('$ref' in schema) return false;
  return (
    schema.type === 'object' &&
    schema.properties === undefined &&
    schema.additionalProperties === undefined &&
    schema.allOf === undefined &&
    schema.oneOf === undefined &&
    schema.anyOf === undefined &&
    !isObjectExample(schema.example)
  );
}

describe('DTO OpenAPI schemas', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(EmptyModule, { logger: false });
  });

  afterAll(async () => {
    await app.close();
  });

  it('gives every property a concrete type', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
      { extraModels: dtoClasses() },
    );

    const shapeless = Object.entries(document.components?.schemas ?? {})
      .flatMap(([schemaName, schema]) =>
        Object.entries(
          ('properties' in schema ? schema.properties : undefined) ?? {},
        ).map(([property, value]) => ({ schemaName, property, value })),
      )
      .filter(({ value }) => isShapelessObject(value))
      .map(({ schemaName, property }) => `${schemaName}.${property}`);

    expect(shapeless).toEqual([]);
  });
});
