# SportsLink: Company Foundation Document

Sep 25, 2026 · @Affan

Source: `SportsLink Company Foundation Document.pdf` in this folder. If the two differ, the PDF is the original.

## 1. Overview

SportsLink is a mobile and web app that lets people in Pakistan book sports venues, fill a match with players, find players nearby in real time, and build a verified sports rating per sport. It launches in Pakistan and is designed to expand to other countries.

**Vision.** Every player can find a game, a team and a ground within minutes, and every player's skill is visible and trusted.

**Mission.** Connect players, venues and organisers on one safe platform, starting with the most played sports in Pakistan.

### The problem

- Booking a ground or court usually means calling or messaging the venue, with no live view of free slots.
- Groups often fall short of players and have no easy way to find reliable strangers to fill the gap.
- Players have no trusted record of their skill, so matches between strangers are often uneven.
- Venue owners manage bookings on paper or WhatsApp, with no analytics and frequent double bookings.
- Local tournaments are scattered, hard to find and poorly organised.

### The solution

1. **Venue booking** for any sport: cricket, football, padel, swimming, badminton, tennis, futsal, basketball and more.
2. **Create a match** at a listed or unlisted venue and invite players to fill open slots, with host approval.
3. **Join a match** that has open slots.
4. **Find Players live**: broadcast a request to players nearby, similar to how a ride app finds nearby drivers.
5. **Profiles, ratings and stats** per sport, with a results-based skill rating similar to chess.com and separate behaviour reviews.
6. **Teams** with their own team rating.
7. **Tournaments** run only by SportsLink, with brackets, results and a separate tournament rating.
8. **Vendor tools**: listings, pricing per court, calendar, manual bookings, analytics and revenue.
9. **Admin panel** with full control over users, venues, commission, billing, tournaments and moderation.

**Future (not in first release):** government trials in partnership with sports bodies, an equipment rental and sports marketplace, and in-app add-ons.

## 2. Market

SportsLink launches in Pakistan, one city first, then expands nationally and abroad. The launch city is still open (see Open decisions).

**Target users**

- Young adults and students (roughly 15 to 35) who play casually and struggle to find players or grounds.
- Office groups and friend circles who play weekly.
- Competitive amateurs who want a visible ranking and tournament access.
- Parents booking coaching or sessions for children (under-18 rules apply, see section 10).
- Venue owners: cricket and futsal grounds, padel and tennis courts, pools, sports complexes, school and club facilities.

**Why expansion is planned in from day one:** currency, language, payment methods, tax and commission rules must be configurable per country, not hard-coded to Pakistan.

### Comparable products

Written from general knowledge, not live research. Verify before using in a pitch.

| Product                               | Region              | What it does                            | What SportsLink adds                                               |
| ------------------------------------- | ------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| Playo                                 | India               | Venue booking, joining games            | Live Find Players, results-based ratings, Pakistan payment methods |
| Hudle                                 | India               | Venue booking, venue software           | Player ratings, teams, tournaments                                 |
| Playtomic                             | Europe, Middle East | Padel and tennis booking, player levels | Multi-sport, Pakistan market                                       |
| CricHeroes                            | India, Pakistan     | Cricket scoring, stats, tournaments     | Booking and matchmaking across all sports                          |
| WhatsApp groups and venue phone lines | Pakistan            | Informal booking and player finding     | Live slots, safety, verified profiles, ratings                     |

A local competitor check in Pakistan is still needed before launch.

## 3. Users and roles

One app serves players and vendors. A person signs up once and can switch between Player mode and Vendor mode. Admins use a separate web panel.

| Role               | Who                            | Main access                                                                        |
| ------------------ | ------------------------------ | ---------------------------------------------------------------------------------- |
| Player             | Anyone who signs up            | Book, create and join matches, Find Players, chat, rate, teams, tournaments        |
| Minor player       | Under 18 with parental consent | Same as player, with the safeguards in section 10                                  |
| Parent or guardian | Linked to a minor's account    | Gives consent, sees the minor's activity                                           |
| Vendor owner       | Verified venue owner           | All branches, venues, pricing, staff, bookings, analytics, billing                 |
| Vendor staff       | Added by the owner             | Only the permissions the owner grants (for example bookings only, one branch only) |
| Admin: Owner       | You                            | Everything, including managing super admins                                        |
| Admin: Super admin | Senior team                    | Everything except ownership settings                                               |
| Admin: Operations  | Ops team                       | Venue approvals, site visits, bookings, disputes, tournaments                      |
| Admin: Finance     | Finance team                   | Commission, plans, vendor billing, payments, revenue reports                       |
| Admin: Moderation  | Trust and safety team          | Reports, bans, chat review on reported conversations, reviews                      |

## 4. Player features

### 4.1 Sign-up and profile

- Sign-up with phone number and OTP. CNIC upload for verification (minors use B-Form, see section 10).
- Profile: name, photo, city, age, gender, sports played, preferred position or role per sport, self-declared level, availability.
- Profile shows skill rating per sport, rank, behaviour badges, matches played, stats and teams.
- Phone number is never shown to other users.

### 4.2 Venue booking

- Search by sport, area, distance, date, time, price and rating.
- Each venue shows courts or grounds, photos, prices per slot, facilities, rules, cancellation policy and reviews.
- Pay an advance to confirm, pay the rest at the venue or before the slot.
- **Per-player bill:** when players book together, each player gets their own share to pay.
- **Recurring booking** (for example every Thursday 9pm), only if the vendor allows it. All weeks are paid in advance.
- Cancellation and no-show refunds follow the vendor's own policy, shown before paying.

### 4.3 Create a match

- Host picks sport, venue (listed or unlisted), date, time, total players needed and players already confirmed.
- Filters: skill level range, age range, gender (including women-only), verified players only.
- Host approves every join request. Host can remove players before the match.
- **Cost split:** the host pays for the players they bring. Each joining player pays their own share.
- Unlisted venues show a clear warning: SportsLink does not verify this venue and is not responsible for it.

### 4.4 Join a match

- Browse open matches by sport, distance, time and level.
- Send a join request. On approval, pay your share to confirm your spot.

### 4.5 Find Players (live)

- Player picks sport, players needed, search radius, time window and optional filters.
- Nearby players get a notification. They accept, and the requester chooses who to take.
- Venue, time and details are agreed in chat, then booked in-app or set as an unlisted venue.
- Only approximate location is ever shown.
- Each player chooses to get these alerts always, or only when "Available to play" is switched on.

### 4.6 Chat

- One-to-one and group chat per match, team and Find Players request.
- Text, photos, voice notes and location sharing.
- If a user types a phone number, show a safety warning, then allow it after confirmation.
- Block and report in every chat.

### 4.7 Ratings, stats and teams

See section 9.

### 4.8 Subscriptions

- Free tier with ads.
- Paid player subscription: no ads, plus other perks to be decided (see Open decisions).

## 5. Vendor features

### 5.1 Onboarding and verification

1. Vendor switches to Vendor mode and submits: CNIC, bank account in the same name as the CNIC, venue details and photos.
2. Ownership or lease document is optional.
3. A site visit is required for every venue. The vendor can request one, or SportsLink schedules one.
4. Operations approves or rejects. Only approved venues are visible to players.

### 5.2 Venue management

- Multiple branches per vendor, multiple courts or grounds per branch.
- Per court: sport, size, surface, photos, facilities, opening hours, slot length.
- Pricing per court, with peak, off-peak, weekend and holiday rates.
- Block time for maintenance or private events.
- Choose policies: cancellation refund on or off, no-show refund on or off, recurring bookings allowed or not, advance amount.
- Add payment details players will pay into: JazzCash, Easypaisa, bank account, cash at venue.

### 5.3 Bookings

- Live calendar of all courts showing app bookings and manual bookings together, so double booking is impossible.
- **Manual booking** for walk-ins and phone bookings. These count toward commission because the vendor uses SportsLink tools for them (policy to confirm, see section 13).
- Confirm payment received, mark no-shows, handle cancellations and refunds per their policy.

### 5.4 Staff

- Owner adds staff with limited permissions, for example one branch only, bookings only, no revenue view.

### 5.5 Insights

- Bookings, occupancy by court and hour, revenue, revenue calculator, reviews and comments, rating trend.
- Reply to reviews.

### 5.6 Billing

- Each vendor is on either a per-booking percentage or a monthly plan, set by SportsLink per vendor.
- Monthly invoice shows every counted booking and the amount due.
- Unpaid invoices lead to warnings, then a block (section 8).

## 6. Admin panel

The admin panel is a web app with full control, split by role (section 3). Every admin action is recorded in an audit log that cannot be edited.

| Area        | What admins can do                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| Venues      | Review applications, schedule and record site visits, approve, reject, suspend, ban low-rated venues            |
| Vendors     | View documents, set billing model and rate per vendor, set promotional rates, block for non-payment             |
| Players     | View profiles, verify CNIC or B-Form, warn, suspend, ban, reset ratings in fraud cases                          |
| Payments    | View each venue's payment methods, flag suspicious details, see disputes and payment reports                    |
| Billing     | Generate monthly invoices, record vendor payments, send reminders, write off or adjust with reason              |
| Moderation  | Handle reports, read reported chats only, remove reviews or photos, manage the abuse queue                      |
| Disputes    | Resolve match result conflicts, booking disputes and refund complaints                                          |
| Tournaments | Create tournaments, brackets, fixtures, enter results, publish rankings                                         |
| Marketing   | Promo codes, first-booking offers, push campaigns, sponsor ads, featured listings                               |
| Content     | Sports list, cities, banners, terms, FAQs                                                                       |
| Analytics   | Revenue, commission due and collected, bookings, active users, retention, top venues, city and sport breakdowns |
| Settings    | Admin users and roles, countries, currencies, commission defaults, feature switches                             |

## 7. Business model

SportsLink earns from vendors, players and sponsors. Rates are set per vendor by admin and are not fixed in code.

| Stream                  | Who pays         | How                                                  | Status            |
| ----------------------- | ---------------- | ---------------------------------------------------- | ----------------- |
| Per-booking commission  | Vendor           | A percentage of each counted booking, billed monthly | Launch            |
| Monthly vendor plan     | Vendor           | A flat monthly fee instead of commission             | Launch            |
| Player subscription     | Player           | Monthly or yearly, removes ads, extra perks          | Launch or phase 2 |
| Sponsor and display ads | Brands           | Banner and in-feed ads shown to free players         | Launch or phase 2 |
| Featured listings       | Vendor           | Paid placement at the top of search                  | Phase 2           |
| Tournament entry fees   | Players or teams | Paid on registration                                 | Phase 2           |
| Marketplace fees        | Sellers          | Commission on rentals and product sales              | Future            |

**Note on player subscriptions.** Apple and Google normally require their own in-app billing for digital subscriptions like ad removal, and take a fee. Venue bookings are physical services and are not affected. Confirm current store rules before building.

## 8. Payments and billing

Players pay vendors directly. SportsLink never holds player money and bills vendors monthly for bookings that came through the app. Because money goes straight to the vendor, vendors effectively receive it the same day.

### 8.1 Payment methods per venue

- JazzCash, Easypaisa, bank transfer and cash at venue. The vendor enables the ones they accept.
- Payment accounts must be in the same name as the verified CNIC. Admin approves every new or changed account before players see it. This blocks the most common scam: a fake account swapped into a real listing.

### 8.2 How a player payment is confirmed

1. Player picks a slot. The slot is held for a short time (for example 15 minutes).
2. Player pays the advance to the vendor's account and enters the transaction ID in the app.
3. Vendor confirms receipt. The booking is then confirmed.
4. If the vendor does not confirm in time, the player is notified and support can step in.
5. Remaining amount is paid at the venue or before the slot, and the vendor marks it paid.

Screenshots alone are never proof of payment. The vendor's confirmation is the source of truth.

### 8.3 Split payments

- Each player sees and pays their own share. A booking is confirmed once the advance is covered.
- In a match, the host pays for the players they brought, and each joiner pays their own share.
- If a share is unpaid by a deadline, the host can replace that player.

### 8.4 Refunds

- The vendor decides if cancellations and no-shows are refundable. The policy is shown before payment.
- Refunds go directly from vendor to player. The app records the refund and the player confirms receipt.

### 8.5 Vendor billing

- Counted bookings: every booking made through the app, plus manual bookings the vendor enters in the app.
- Invoice on the 1st of each month. SportsLink payment accounts are shown on the invoice.
- Reminder at 7 days, warning at 14 days, venue hidden from search at 21 days, account blocked at 30 days. Timings are admin settings.

### 8.6 Risks with this model and my recommendation

**Risks:** vendors can take the booking but skip confirming it, move regulars to WhatsApp, or not pay invoices. Every unpaid invoice becomes a debt you chase manually.

**Recommended option (your decision): prepaid vendor credit.** Vendors top up a SportsLink balance. Commission is deducted automatically as each booking is confirmed. When the balance runs out, new app bookings pause until they top up. SportsLink still never holds player money, and there is nothing to chase.

**Second option: collect only the advance.** The player pays the advance through a licensed payment gateway. SportsLink keeps its commission from it and passes the rest to the vendor. This is the safest for players and for collection, but it does mean handling money and needs a licensed provider.

## 9. Ratings, rankings and tournaments

SportsLink has three separate scores so each stays fair: a skill rating from results, behaviour reviews from other players, and a tournament rating controlled only by SportsLink.

| Score                         | Based on                    | Who controls it             | Shown as                                             |
| ----------------------------- | --------------------------- | --------------------------- | ---------------------------------------------------- |
| Skill rating (per sport)      | Match results               | Calculated automatically    | A number and a tier, for example 1450, Silver        |
| Team rating (per sport)       | Team match results          | Calculated automatically    | A number and a tier on the team page                 |
| Behaviour reviews             | Other players after a match | Players, moderated by admin | Stars and badges: punctual, fair play, good teammate |
| Tournament rating (per sport) | Official tournament results | SportsLink only             | A separate number and tournament rank                |

### 9.1 How the skill rating works

- Uses the Glicko-2 method, the same family of maths chess.com uses. Beating a stronger opponent gains more points than beating a weaker one.
- New players start at a default rating with high uncertainty, so their rating moves fast at first, then settles.
- For team sports, each player's rating moves based on the team result and the average rating of both teams.
- Only confirmed matches count: both sides agree the result. If they disagree, either side raises it and SportsLink decides.
- Protections: repeated matches between the same people count less, and admins can reverse ratings gained by fraud.

### 9.2 Behaviour reviews

- Only players who were in the same confirmed match can review each other, within 48 hours.
- Reviews do not affect the skill rating.
- Low behaviour scores and reports feed into moderation and possible bans.

### 9.3 Stats

- Basic stats for everyone: matches played, wins, losses, win rate, sports played, streaks, rating history.
- Detailed stats are optional, chosen by the players in each match, for example cricket runs and wickets, football goals and assists.

### 9.4 Leaderboards

- Per sport, showing top players and teams, with a player's own position visible.
- City and national filters planned for expansion.

### 9.5 Teams

- A player creates a team for a sport, invites members, sets a captain.
- Teams can create matches against other teams and enter tournaments.

### 9.6 Tournaments

- Created only by SportsLink admin.
- Individual and team entries, entry fees and prizes through the app.
- Formats: knockout, league, round robin, groups then knockout.
- Brackets, fixtures, results and standings, all entered by admin.
- Government trials appear as "Coming soon".

## 10. Trust, safety and minors

Safety is the first priority. The app connects strangers who meet in person, so every feature is designed around verified identity, hidden contact details and fast reporting.

### 10.1 Safety for everyone

- Phone OTP plus CNIC verification. Verified badge on profiles.
- Phone numbers always hidden. Warning shown if a number is typed in chat.
- Approximate location only, never exact.
- Match filters for gender (including women-only), age and verified-only.
- Block and report from any profile, chat or match.
- Warning on every unlisted venue.
- Venue check-in by QR code at listed venues to confirm the match happened.
- Reliability score: frequent late cancellations and no-shows are visible to hosts.

### 10.2 Under-18 players

**Your decision:** anyone can join. Under-18s need parental consent. Parents are told everything upfront, and once they agree the responsibility is theirs.

**My recommendation:** parental consent alone does not fully protect SportsLink. Consent terms may not hold up legally, and Apple and Google review apps closely when adults and minors can chat and meet. A single incident could close the app. I recommend these safeguards stay on even after consent:

- Minimum age of 13. Under-13s only through a parent's account.
- Minors verify with a B-Form and a linked parent account that has passed CNIC verification.
- Adults cannot start a private chat with a minor. Minors chat only in group chats of matches they are confirmed in.
- Minors do not receive Find Players alerts from adults, and do not appear in adult Find Players results, unless the parent turns this on.
- Parents get notified of every booking, match and team a minor joins.
- Reports involving minors go to the top of the moderation queue.

Please confirm which of these you accept (Open decisions).

## 11. Legal and compliance points

These are points to take to a Pakistani lawyer, not legal advice. I'm not a lawyer, and I couldn't check current law from this chat.

| Topic                | What to ask the lawyer                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Company registration | Registering with SECP, tax registration for commission and subscription income                                                  |
| Terms of use         | Platform acts as a marketplace only, not responsible for venues, injuries, or disputes between users                            |
| Injury waiver        | A waiver players accept before every match or booking                                                                           |
| Unlisted venues      | Wording of the no-responsibility warning                                                                                        |
| Minors               | Whether parental consent is valid, what extra protection the law requires                                                       |
| Data protection      | Storing CNIC images and location data, the status of Pakistan's data protection law, where data may be hosted                   |
| Online content       | Obligations under PECA 2016 for chat, reports and takedowns                                                                     |
| Payments             | Whether direct vendor payments, prepaid vendor credit, or collecting the advance need a licence from the State Bank of Pakistan |
| Tournaments          | Rules for prize money and entry fees so it is not treated as gambling                                                           |
| Ads                  | Rules on sponsor ads, especially ads shown to minors                                                                            |
| Government trials    | Agreement terms with sports bodies when that feature starts                                                                     |

## 12. Roadmap

The full product cannot be built well in 1.5 months. A focused first release is realistic in about 10 to 12 weeks with a team of 5 to 6, and everything else follows in phases. Estimates assume an experienced team and are approximate.

| Phase               | Weeks (approx.) | What ships                                                                                                                                                                                                   |
| ------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0. Setup and design | 2               | Final scope, UX designs, architecture, legal terms started                                                                                                                                                   |
| 1. Launch release   | 8 to 10         | Sign-up and verification, profiles, vendor onboarding and site visits, venue listings, booking with advance and split bills, manual bookings, create and join match, chat, basic admin panel, vendor billing |
| 2. Growth           | 6 to 8          | Find Players live, skill rating and behaviour reviews, teams, leaderboards, vendor analytics, player subscription, ads, promo codes                                                                          |
| 3. Tournaments      | 4 to 6          | Tournament creation, registration, brackets, results, tournament rating, detailed stats                                                                                                                      |
| 4. Future           | Later           | Government trials, marketplace for rentals and sales, add-ons, new countries                                                                                                                                 |

**If 1.5 months is fixed:** a smaller pilot is possible with venue listings, booking, create and join match, basic chat, and a basic admin panel, in one city with a few hand-picked venues. Find Players, ratings and tournaments would come after.

## 13. Risks and recommendations

| Risk                              | Why it matters                                                                 | Recommendation                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Unpaid vendor invoices            | Direct payments mean you chase every bill                                      | Prepaid vendor credit (section 8.6)                                                                        |
| Vendors moving regulars off-app   | Lost commission                                                                | Make the app worth using: calendar, analytics, free manual booking for customers not sourced by SportsLink |
| Commission on manual bookings     | Vendors may stop entering walk-ins, which breaks the double-booking protection | Consider free manual bookings, or a lower rate for them                                                    |
| Empty marketplace at launch       | Players leave if there are no venues, venues leave if there are no players     | Launch in one city, sign 30 to 50 venues before opening to players                                         |
| Find Players notification spam    | Players switch notifications off                                               | Default to "only when Available to play", cap alerts per day                                               |
| Rating fraud                      | Friends boosting each other destroys trust                                     | Confirmed results, QR check-in, reduced weight for repeat opponents                                        |
| Mandatory CNIC at sign-up         | Many users drop off before trying the app                                      | Let users browse and book with OTP, require CNIC to create, join or use Find Players                       |
| Safety incident involving a minor | Legal, reputational and app store risk                                         | Safeguards in section 10.2                                                                                 |
| Timeline                          | 1.5 months is too short for full scope                                         | Phased roadmap (section 12)                                                                                |
| Store billing for subscriptions   | Store fees on ad-free plans                                                    | Price subscriptions with store fees included                                                               |

## 14. Open decisions

- [ ] Launch city: Lahore, Karachi or Islamabad?
- [ ] Billing model: postpaid monthly invoices, prepaid vendor credit, or collecting the advance (section 8.6)?
- [ ] Commission on manual bookings: full rate, lower rate, or free?
- [ ] Default commission percentage and monthly plan price?
- [ ] Advance amount: fixed by SportsLink, or set by each vendor within limits?
- [ ] Under-18 safeguards: which of section 10.2 do you accept?
- [ ] CNIC timing: at sign-up, or only before creating, joining or Find Players?
- [ ] Player subscription perks beyond no ads?
- [ ] Sports list for launch?
- [ ] Languages: English only, or Urdu at launch?
- [ ] Brand colours and logo for SportsLink?
- [ ] Budget, once known.
