DO $migration$
BEGIN
    IF current_database() <> 'game_collection' THEN
        RAISE EXCEPTION 'Select game_collection';
    END IF;
    ALTER TABLE public.user_games ADD COLUMN IF NOT EXISTS queue_rank integer CHECK (queue_rank > 0);
END
$migration$;
