-- Optional browser-owned payload encryption material. Legacy endpoints remain valid.
ALTER TABLE doctor_push_subscriptions ADD COLUMN p256dh TEXT;
ALTER TABLE doctor_push_subscriptions ADD COLUMN auth TEXT;
