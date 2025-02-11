import { IntegrationError, RequestClient, RetryableError } from '@segment/actions-core'
import { createHash } from 'crypto'
import { TikTokAudiences } from './api'
import { Payload as AddUserPayload } from './addUser/generated-types'
import { Payload as RemoveUserPayload } from './removeUser/generated-types'
import { Settings } from './generated-types'

type GenericPayload = AddUserPayload | RemoveUserPayload

export async function processPayload(
  request: RequestClient,
  settings: Settings,
  payloads: GenericPayload[],
  action: string
) {
  validate(payloads)

  const selected_advertiser_id = payloads[0].selected_advertiser_id ?? undefined
  const TikTokApiClient: TikTokAudiences = new TikTokAudiences(request, selected_advertiser_id)

  const id_schema = getIDSchema(payloads[0])

  const users = extractUsers(payloads)

  let res
  if (users.length > 0) {
    const elements = {
      advertiser_ids: settings.advertiser_ids,
      action: action,
      id_schema: id_schema,
      batch_data: users
    }
    res = await TikTokApiClient.batchUpdate(elements)

    // At this point, if TikTok's API returns a 400 error, it's because the audience
    // Segment just created isn't available yet for updates via this endpoint.
    // Audiences are usually available to accept batches of data 1 - 2 minutes after
    // they're created. Here, we'll throw an error and let Centrifuge handle the retry.
    if (res.status !== 200) {
      throw new RetryableError('Error while attempting to update TikTok Audience. This batch will be retried.')
    }
  }

  return res
}

export function validate(payloads: GenericPayload[]): void {
  if (payloads[0].send_email === false && payloads[0].send_advertising_id === false) {
    throw new IntegrationError(
      'At least one of `Send Email`, or `Send Advertising ID` must be set to `true`.',
      'INVALID_SETTINGS',
      400
    )
  }
}

export function getIDSchema(payload: GenericPayload): string[] {
  const id_schema = []
  if (payload.send_email === true) {
    id_schema.push('EMAIL_SHA256')
  }
  if (payload.send_advertising_id === true) {
    id_schema.push('IDFA_SHA256')
  }

  return id_schema
}

export function extractUsers(payloads: GenericPayload[]): {}[][] {
  const batch_data: {}[][] = []

  payloads.forEach((payload: GenericPayload) => {
    if (!payload.email && !payload.advertising_id) {
      return
    }

    const user_ids: {}[] = []

    if (payload.send_email === true) {
      let email_id = {}
      if (payload.email) {
        payload.email = payload.email.replace(/\+.*@/, '@').replace(/\./g, '').toLowerCase()
        email_id = {
          id: createHash('sha256').update(payload.email).digest('hex'),
          audience_ids: [payload.audience_id]
        }
      }
      user_ids.push(email_id)
    }

    if (payload.send_advertising_id === true) {
      let advertising_id = {}
      if (payload.advertising_id) {
        advertising_id = {
          id: createHash('sha256').update(payload.advertising_id).digest('hex'),
          audience_ids: [payload.audience_id]
        }
      }
      user_ids.push(advertising_id)
    }

    batch_data.push(user_ids)
  })
  return batch_data
}
