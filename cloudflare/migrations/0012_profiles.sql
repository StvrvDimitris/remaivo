-- Several people can share one Remaivo password, each with their own profile
-- (an auth identity whose google_sub starts with 'password:'). A new sign-in
-- first asks who is using Remaivo; existing sessions stay with the owner.
ALTER TABLE auth_sessions ADD COLUMN profile_chosen INTEGER NOT NULL DEFAULT 1;
-- Each profile's card can be customised with a colour and an icon (an emoji,
-- or the first letter of the name when empty).
ALTER TABLE auth_identities ADD COLUMN avatar_color TEXT NOT NULL DEFAULT '';
ALTER TABLE auth_identities ADD COLUMN avatar_icon TEXT NOT NULL DEFAULT '';
