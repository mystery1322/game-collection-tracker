BEGIN;
DO $guard$
BEGIN
    IF current_database() <> 'game_collection' THEN
        RAISE EXCEPTION 'Select game_collection before running this migration';
    END IF;
END
$guard$;
ALTER TABLE public.user_games ADD COLUMN next_step varchar(240) NOT NULL DEFAULT '';
COMMIT;
