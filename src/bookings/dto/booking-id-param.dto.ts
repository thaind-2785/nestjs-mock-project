import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

const bookingPublicIdPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export class BookingIdParamDto {
  @ApiProperty({
    description:
      'Server-generated 26-character Crockford base32 ULID. Internal numeric keys are never accepted here.',
    pattern: bookingPublicIdPattern.source,
    example: '01K4N8G4X8R0K1F2Q7V6S9T3AB',
  })
  @IsString()
  @Matches(bookingPublicIdPattern)
  bookingId!: string;
}
