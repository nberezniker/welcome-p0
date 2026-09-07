# RLS / authorization requirements
RLS is defense-in-depth, not a replacement for application authorization. If using Supabase/Auth claims, write policies only after claim structure is known.

Must prove:
- anonymous can read only public profile/event DTOs through intended API/view;
- user can mutate only own profile/contact/note/consent;
- participant cannot list arbitrary event members outside event visibility rules;
- organizer staff sees only assigned event projection and cannot read global contacts/notes;
- organizer admin/owner roles cannot bypass participant intro privacy;
- service-role routes still validate application actor/object permissions before returning private data;
- deleted/revoked data is no longer returned by cached/public endpoints;
- direct SQL/API negative fixtures run with two independent tenants.
