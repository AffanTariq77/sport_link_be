import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError, withErrors } from '../api-error.js';
import { User } from '../auth/auth.controller.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { gender } from '../db/schema.js';
import { type DocumentImage, VerificationError, VerificationService } from '../verification/verification.service.js';
import { ProfileError, ProfileService } from './profile.service.js';

const ProfileBody = z
  .object({
    name: z.string().trim().min(1, 'Enter your name.').max(80),
    dob: z.iso.date('Enter your date of birth.').meta({ example: '2000-01-31' }),
    gender: z.enum(gender.enumValues),
    city: z.string().trim().min(1, 'Enter your city.').max(80),
  })
  .meta({ id: 'ProfileUpdate' });

const VerificationStatus = z
  .object({
    status: z.enum(['none', 'pending', 'approved', 'rejected']),
    rejectionReason: z.string().nullable(),
    docType: z.enum(['cnic', 'b_form']),
    requiredAt: z.enum(['signup', 'before_participation']),
  })
  .meta({ id: 'VerificationStatus' });

const PROFILE_STATUS: Record<ProfileError['code'], number> = { INVALID_DOB: 400, DOB_LOCKED: 409, TOO_YOUNG: 400 };
const VERIFICATION_STATUS: Record<VerificationError['code'], number> = {
  PROFILE_INCOMPLETE: 409,
  INVALID_DOCUMENT_NUMBER: 400,
  INVALID_IMAGE: 400,
  ALREADY_PENDING: 409,
  ALREADY_VERIFIED: 409,
  DUPLICATE_DOCUMENT: 409,
};

type Uploads = { front?: DocumentImage[]; back?: DocumentImage[] };

@Controller('me')
@UseGuards(AuthGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class MeController {
  constructor(
    @Inject(ProfileService) private readonly profile: ProfileService,
    @Inject(VerificationService) private readonly verification: VerificationService,
  ) {}

  @Patch('profile')
  @ApiOkResponse({ standardSchema: User })
  updateProfile(@Req() req: AuthedRequest, @Body({ schema: ProfileBody }) body: z.infer<typeof ProfileBody>) {
    return withErrors(ProfileError, PROFILE_STATUS, () => this.profile.update(req.auth.user.id, body));
  }

  @Get('verification')
  @ApiOkResponse({ standardSchema: VerificationStatus })
  verificationStatus(@Req() req: AuthedRequest) {
    return this.verification.status(req.auth.user.id);
  }

  @Post('verification')
  @HttpCode(200)
  @UseInterceptors(
    // Hard cap to protect memory. The service applies the configurable limit (verification.max_image_bytes).
    FileFieldsInterceptor(
      [
        { name: 'front', maxCount: 1 },
        { name: 'back', maxCount: 1 },
      ],
      {
        limits: { fileSize: 10_000_000, files: 2, fields: 1 },
      },
    ),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['docNumber', 'front', 'back'],
      properties: {
        docNumber: { type: 'string', example: '99999-9999999-9' },
        front: { type: 'string', format: 'binary' },
        back: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiOkResponse({ standardSchema: VerificationStatus })
  submitVerification(
    @Req() req: AuthedRequest,
    @Body() body: { docNumber?: unknown } | undefined, // multipart text field; the service validates it
    @UploadedFiles() files: Uploads,
  ) {
    return withErrors(VerificationError, VERIFICATION_STATUS, async () => {
      const [front, back] = [files?.front?.[0], files?.back?.[0]];
      if (!front || !back) throw new VerificationError('INVALID_IMAGE', 'Add photos of the front and back.');
      const docNumber = typeof body?.docNumber === 'string' ? body.docNumber.slice(0, 20) : '';
      return this.verification.submit(req.auth.user.id, { docNumber, front, back });
    });
  }
}
