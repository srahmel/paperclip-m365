# WP07 calendar domain

The module exports `createCalendarModule()` using the shared DomainModule contract. Only the shared governed executor can dispatch mutations. No live Microsoft test or invitation was performed during implementation.

## Permissions and scope

Calendar inventory uses `calendars:self`; event reads and writes use the exact case-sensitive `calendar:<id>` resource. Inventory returns only owned calendars. An inventory grant does not grant event access. Metadata reads use the `calendar-list-calendars` operation with that exact calendar resource, and existing-event preflight uses `calendar-get-event`; both require explicit read grants independently of mutation permission.

Internal metadata routes required by the adapter are GET `/me/calendars/{id}` (Calendars.Read) and GET `/me/outlook/supportedTimeZones` (User.Read). There is no arbitrary URL, user, header or OData input. Own-calendar checks require `canShare:true` and `isSharedWithMe:false`, plus `canEdit:true` for mutations. A shared calendar with write permission is still denied. These checks run again at execution. [Calendar properties](https://learn.microsoft.com/en-us/graph/api/resources/calendar?view=graph-rest-1.0), [supportedTimeZones](https://learn.microsoft.com/en-us/graph/api/outlookuser-supportedtimezones?view=graph-rest-1.0).

## Inputs and previews

Six tools expose calendar inventory, bounded calendarView, event details and preparation of create/update/delete. Closed schemas reject provider fields, recurrence, arbitrary time zones, attachments, room/resource attendees and online-meeting creation. A new event requires subject, bodyText, location, time and an explicit attendees array (empty is allowed). Updates accept only a nonempty subset of those fields. Limits: 100 records per page, 93-day calendarView, 255-byte subject/location, 64-KiB UTF-8 text and 50 attendees. Read projections contain a provider body preview, not a complete body; incoming content is untrusted data.

Timed inputs require second-resolution RFC3339 with explicit offset and the zone UTC or Europe/Berlin. The local date/time is round-tripped against that zone: DST gaps and incorrect offsets are rejected. The explicit offset distinguishes autumn's repeated hour. Graph receives UTC instants for timed events. All-day inputs use startDate and exclusive endDate; Graph receives local midnight in the same validated zone, preserving 23/25-hour days. [Event time properties](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0).

The encrypted snapshot includes the concrete change, prior event projection for update/delete, calendar/event identifiers, changeKey, notification effect and a server-generated transactionId for create. It displays all current and proposed attendees. Create with attendees explicitly indicates invitations; update indicates possible meeting updates; organizer-delete indicates cancellations. No notification-suppression flag is offered. Existing online meetings cannot be updated because replacing the body could destroy the meeting blob. [Create](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0), [Update](https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0), [Delete](https://learn.microsoft.com/en-us/graph/api/event-delete?view=graph-rest-1.0).

## Execution and limits

calendarView reads include recurring occurrences and exceptions. Mutations require a noncancelled singleInstance, null recurrence and seriesMasterId, and the calendar owner's organizer role. Missing guard fields fail closed. The current event projection and changeKey must match the approved prior snapshot. Current authority is checked before dispatch, in addition to the shared Graph adapter's checks.

**The version preflight is not atomic with PATCH/DELETE.** Those endpoint references do not document If-Match. No If-Match header or lost-update guarantee is invented; an external edit between the final read and mutation remains possible. This is a documented validation limit, not proof of safe concurrent mutation. A future stronger gate needs evidence of a provider conditional-write contract.

Create sends its frozen transactionId once; an ambiguous result remains unknown without a retry. Successful generic results contain only fixed summaries. Created/updated resource IDs are returned through the encrypted private-result mechanism. No event body, attendee or provider error enters generic results.

Synthetic tests cover ownership, closed inputs, UTF-8 limits, DST/all-day boundaries, series restrictions, organizer guards, invitation/cancellation previews, version changes, live authority revocation and unknown outcomes. Real mailbox behavior, invitation/cancellation delivery and external-concurrency behavior still need explicitly authorized test-account acceptance. [calendarView](https://learn.microsoft.com/en-us/graph/api/user-list-calendarview?view=graph-rest-1.0).
