import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError, withErrors } from '../api-error.js';
import { advanceType, paymentMethod } from '../db/schema.js';
import { VenueError, VenuesService } from './venues.service.js';

const STATUS: Record<VenueError['code'], number> = { NOT_FOUND: 404, INVALID_DATE: 400 };
const run = <T>(fn: () => Promise<T>) => withErrors(VenueError, STATUS, fn);

const Sport = z.object({ slug: z.string(), name: z.string() }).meta({ id: 'Sport' });
const VenueSummary = z
  .object({
    id: z.uuid(),
    name: z.string(),
    city: z.string(),
    address: z.string(),
    facilities: z.array(z.string()),
    photos: z.array(z.string()).meta({ description: 'Photo paths on this API, first is the cover' }),
    sports: z.array(z.string()),
    courtCount: z.int(),
    currency: z.string(),
    fromPricePerHour: z.int().nullable().meta({ description: 'Lowest hourly price, minor units' }),
  })
  .meta({ id: 'VenueSummary' });
const Policy = z
  .object({
    advanceType: z.enum(advanceType.enumValues),
    advanceValue: z.int().meta({ description: 'Basis points if percentage, minor units if fixed' }),
    cancelRefund: z.boolean(),
    cancelWindowHours: z.int(),
    noShowRefund: z.boolean(),
  })
  .meta({ id: 'VenuePolicy' });
const Venue = VenueSummary.omit({ sports: true, courtCount: true, fromPricePerHour: true })
  .extend({
    rules: z.string().nullable(),
    timezone: z.string(),
    courts: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        surface: z.string().nullable(),
        slotMinutes: z.int(),
        sports: z.array(z.string()),
      }),
    ),
    policy: Policy,
    paymentMethods: z.array(z.enum(paymentMethod.enumValues)),
  })
  .meta({ id: 'Venue' });
const Slots = z
  .object({
    currency: z.string(),
    slots: z.array(
      z.object({
        startAt: z.iso.datetime(),
        endAt: z.iso.datetime(),
        price: z.int().meta({ description: 'Minor units' }),
        available: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'CourtSlots' });

const VenueQuery = z.object({ sport: z.string().max(40).optional(), city: z.string().max(80).optional() });
const SlotQuery = z.object({ date: z.iso.date('Choose a date.') });
const Id = z.uuid('Not found.');

@Controller()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class VenuesController {
  constructor(@Inject(VenuesService) private readonly venues: VenuesService) {}

  @Get('sports')
  @ApiOkResponse({ standardSchema: z.array(Sport) })
  listSports() {
    return this.venues.listSports();
  }

  @Get('venues')
  @ApiOkResponse({ standardSchema: z.array(VenueSummary) })
  list(@Query({ schema: VenueQuery }) query: z.infer<typeof VenueQuery>) {
    return this.venues.list(query);
  }

  @Get('venues/:id')
  @ApiOkResponse({ standardSchema: Venue })
  get(@Param('id', { schema: Id }) id: string) {
    return run(() => this.venues.get(id));
  }

  @Get('courts/:id/slots')
  @ApiOkResponse({ standardSchema: Slots })
  slots(@Param('id', { schema: Id }) id: string, @Query({ schema: SlotQuery }) query: z.infer<typeof SlotQuery>) {
    return run(() => this.venues.slots(id, query.date));
  }
}
