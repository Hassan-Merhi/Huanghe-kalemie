-- The owner account is shown as "Propriétaire" on every screen. Older installs created it as "Owner";
-- only that untouched default name changes.
UPDATE "users" SET "full_name" = 'Propriétaire' WHERE "role" = 'owner' AND "full_name" = 'Owner';
