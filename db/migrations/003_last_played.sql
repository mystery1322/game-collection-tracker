BEGIN;
DO $guard$
BEGIN
    IF current_database() <> 'game_collection' THEN
        RAISE EXCEPTION 'Select game_collection before running this migration';
    END IF;
END
$guard$;
ALTER TABLE public.user_games ADD COLUMN last_played_at timestamptz;
COMMIT;
