BEGIN;
DO $guard$
BEGIN
    IF current_database() <> 'game_collection' THEN
        RAISE EXCEPTION 'Select game_collection before running this migration';
    END IF;
END
$guard$;
ALTER TABLE public.users
    ADD COLUMN steam_login_id varchar(17) UNIQUE CHECK (steam_login_id ~ '^[0-9]{17}$'),
    ALTER COLUMN email DROP NOT NULL,
    ALTER COLUMN password_hash DROP NOT NULL,
    ADD CONSTRAINT users_credentials CHECK (
        (email IS NOT NULL AND password_hash IS NOT NULL)
        OR (steam_login_id IS NOT NULL AND email IS NULL AND password_hash IS NULL)
    );
COMMIT;
