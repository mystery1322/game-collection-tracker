BEGIN;
DO $$ BEGIN
    IF current_database() <> 'game_collection' THEN RAISE EXCEPTION 'Select game_collection'; END IF;
END $$;
ALTER TABLE public.user_games DROP CONSTRAINT user_games_status,
    ADD CONSTRAINT user_games_status CHECK (status IN ('unassigned','planned','playing','completed','paused','dropped')),
    ALTER COLUMN status SET DEFAULT 'unassigned';
-- Only convert automatic Steam defaults last written during an import.
UPDATE public.user_games ug SET status='unassigned'
FROM public.games g WHERE g.id=ug.game_id AND g.steam_app_id IS NOT NULL
  AND ug.status='planned' AND ug.notes='' AND ug.next_step='' AND ug.rating IS NULL
  AND EXISTS (SELECT 1 FROM public.steam_sync_runs s WHERE s.user_id=ug.user_id
      AND s.status='success' AND ug.updated_at BETWEEN s.started_at AND s.finished_at);
COMMIT;
