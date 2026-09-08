import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { CurrentPrincipal } from '../auth/decorators/current-principal.decorator';
import { AttachmentUploadErrorInterceptor } from '../files/attachment-upload.interceptor';
import { AttachmentUploadRateLimitGuard } from '../files/attachment-upload-rate-limit.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { createValidationException } from '../common/errors/validation-errors';
import { UserRole } from '../users/entities/user.enums';
import { RoomImageIdParamDto } from './dto/room-id-param.dto';
import {
  ReorderRoomImagesDto,
  roomImageAssociationTypes,
  UploadRoomImageDto,
} from './dto/room-image-request.dto';
import { RoomImageResponseDto } from './dto/room-image-response.dto';
import { RoomIdParamDto } from './dto/room-id-param.dto';
import { RoomImagesService } from './room-images.service';

@ApiTags('Admin room images')
@ApiBearerAuth()
@Roles(UserRole.Admin)
@Controller('admin/rooms/:roomId/images')
export class AdminRoomImagesController {
  public constructor(private readonly images: RoomImagesService) {}

  @Post()
  // Order matters: guards run before interceptors, so the per-uploader budget is
  // charged before Multer buffers the body. Multer then buffers into memory up to
  // the configured size limit, registered from configuration in RoomsModule, and
  // the policy re-checks the accepted size after the signature is verified.
  @UseGuards(AttachmentUploadRateLimitGuard)
  @UseInterceptors(AttachmentUploadErrorInterceptor, FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'associationType'],
      properties: {
        file: { type: 'string', format: 'binary' },
        associationType: {
          type: 'string',
          enum: [...roomImageAssociationTypes],
        },
      },
    },
  })
  @ApiCreatedResponse({ type: RoomImageResponseDto })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'ATTACHMENT_LIMIT_EXCEEDED: the album is already full.',
  })
  @ApiResponse({
    status: 413,
    type: ErrorResponseDto,
    description: 'ATTACHMENT_SIZE_EXCEEDED: the file is above the size limit.',
  })
  @ApiResponse({
    status: 415,
    type: ErrorResponseDto,
    description: 'ATTACHMENT_MIME_UNSUPPORTED: unsupported declared format.',
  })
  @ApiResponse({
    status: 429,
    type: ErrorResponseDto,
    description:
      'ATTACHMENT_UPLOAD_RATE_LIMITED: the uploader spent its upload budget.',
  })
  @ApiResponse({
    status: 503,
    type: ErrorResponseDto,
    description:
      'ATTACHMENT_UPLOAD_UNAVAILABLE or STORAGE_UNAVAILABLE: uploads fail closed.',
  })
  upload(
    @Param() params: RoomIdParamDto,
    @Body() body: UploadRoomImageDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): Promise<RoomImageResponseDto> {
    // The multipart part is required, so its absence is reported the same way the
    // global pipe reports any missing field rather than as a storage error.
    if (!file?.buffer?.length) {
      throw createValidationException([
        { property: 'file', constraints: { isDefined: 'file is required' } },
      ]);
    }

    return this.images.upload(params.roomId, {
      associationType: body.associationType,
      uploaderUserId: principal.userId,
      declaredMimeType: file.mimetype,
      body: file.buffer,
    });
  }

  @Patch('order')
  @ApiOkResponse({ type: [RoomImageResponseDto] })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description:
      'ATTACHMENT_ORDER_INVALID: the list is not the current album exactly once.',
  })
  reorder(
    @Param() params: RoomIdParamDto,
    @Body() body: ReorderRoomImagesDto,
  ): Promise<RoomImageResponseDto[]> {
    return this.images.reorder(params.roomId, body.attachmentIds);
  }

  @Delete(':attachmentId')
  @HttpCode(204)
  @ApiNoContentResponse()
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description:
      'ATTACHMENT_NOT_FOUND: unknown ID, or an ID that belongs to another room.',
  })
  delete(@Param() params: RoomImageIdParamDto): Promise<void> {
    return this.images.delete(params.roomId, params.attachmentId);
  }
}
