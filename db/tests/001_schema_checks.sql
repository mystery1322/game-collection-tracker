-- Run as a whole script against game_collection. No test rows remain.
-- Test failures raise an exception; ROLLBACK also handles an aborted transaction.
BEGIN;

DO $tests$
DECLARE
    user_a integer;
    user_b integer;
    user_empty integer;
    shared_game integer;
    manual_game integer;
    entry_a integer;
    sync_id integer;
    before_update timestamptz;
    stats record;
    test_suffix text := txid_current()::text;
    checks_passed integer := 0;
BEGIN
    IF current_database() <> 'game_collection' THEN
        RAISE EXCEPTION 'Select game_collection before running these checks';
    END IF;

    INSERT INTO public.users(email,password_hash,display_name)
    VALUES ('schema-a-' || test_suffix || '@example.invalid',repeat('x',64),'Schema test A')
    RETURNING id INTO user_a;
    INSERT INTO public.users(email,password_hash,display_name)
    VALUES ('schema-b-' || test_suffix || '@example.invalid',repeat('x',64),'Schema test B')
    RETURNING id INTO user_b;
    INSERT INTO public.users(email,password_hash,display_name)
    VALUES ('schema-empty-' || test_suffix || '@example.invalid',repeat('x',64),'Empty test')
    RETURNING id INTO user_empty;

    -- In a new schema choose an unused uint32 AppID; never alter an existing game.
    INSERT INTO public.games(steam_app_id,title)
    SELECT candidate, 'Schema test Steam game'
    FROM generate_series(4294967295::bigint,4294967000::bigint,-1::bigint) AS candidate
    WHERE NOT EXISTS (SELECT 1 FROM public.games WHERE steam_app_id = candidate)
    LIMIT 1 RETURNING id INTO shared_game;
    IF shared_game IS NULL THEN RAISE EXCEPTION 'No free test AppID'; END IF;
    INSERT INTO public.games(title,created_by)
    VALUES ('Schema test manual game',user_a) RETURNING id INTO manual_game;

    INSERT INTO public.user_games(user_id,game_id,status,playtime_minutes,rating,notes,completed_at)
    VALUES(user_a,shared_game,'completed',120,8,'Keep this note',CURRENT_DATE)
    RETURNING id,updated_at INTO entry_a,before_update;
    INSERT INTO public.user_games(user_id,game_id,status,playtime_minutes)
    VALUES(user_a,manual_game,'playing',60);
    INSERT INTO public.user_games(user_id,game_id,status,playtime_minutes,rating)
    VALUES(user_b,shared_game,'planned',10,2);

    SELECT * INTO stats FROM public.user_statistics WHERE user_id=user_a;
    IF stats.total_games<>2 OR stats.completed_games<>1 OR stats.playing_games<>1
       OR stats.total_playtime_minutes<>180 OR stats.average_rating<>8
       OR stats.completion_percent<>50 THEN
        RAISE EXCEPTION 'Statistics do not match the expected collection: %',row_to_json(stats);
    END IF;
    checks_passed:=checks_passed+1;

    SELECT * INTO stats FROM public.user_statistics WHERE user_id=user_b;
    IF stats.total_games<>1 OR stats.total_playtime_minutes<>10 OR stats.average_rating<>2 THEN
        RAISE EXCEPTION 'Statistics from different users are mixed';
    END IF;
    checks_passed:=checks_passed+1;

    SELECT * INTO stats FROM public.user_statistics WHERE user_id=user_empty;
    IF stats.total_games<>0 OR stats.total_playtime_minutes<>0
       OR stats.average_rating IS NOT NULL OR stats.completion_percent<>0 THEN
        RAISE EXCEPTION 'Empty collection statistics are incorrect';
    END IF;
    checks_passed:=checks_passed+1;

    BEGIN
        INSERT INTO public.users(email,password_hash,display_name)
        VALUES ('SCHEMA-A-' || test_suffix || '@EXAMPLE.INVALID',repeat('x',64),'Duplicate');
        RAISE EXCEPTION 'Case-insensitive email uniqueness failed';
    EXCEPTION WHEN unique_violation THEN checks_passed:=checks_passed+1;
    END;

    BEGIN
        INSERT INTO public.user_games(user_id,game_id) VALUES(user_a,shared_game);
        RAISE EXCEPTION 'Duplicate collection entry was accepted';
    EXCEPTION WHEN unique_violation THEN checks_passed:=checks_passed+1;
    END;

    BEGIN
        UPDATE public.user_games SET rating=11 WHERE id=entry_a;
        RAISE EXCEPTION 'An out-of-range rating was accepted';
    EXCEPTION WHEN check_violation THEN checks_passed:=checks_passed+1;
    END;

    BEGIN
        UPDATE public.user_games SET playtime_minutes=-1 WHERE id=entry_a;
        RAISE EXCEPTION 'Negative playtime was accepted';
    EXCEPTION WHEN check_violation THEN checks_passed:=checks_passed+1;
    END;

    BEGIN
        UPDATE public.user_games SET status='unknown' WHERE id=entry_a;
        RAISE EXCEPTION 'An invalid status was accepted';
    EXCEPTION WHEN check_violation THEN checks_passed:=checks_passed+1;
    END;

    BEGIN
        UPDATE public.user_games SET completed_at=CURRENT_DATE+1 WHERE id=entry_a;
        RAISE EXCEPTION 'A future completion date was accepted';
    EXCEPTION WHEN check_violation THEN checks_passed:=checks_passed+1;
    END;

    BEGIN
        INSERT INTO public.user_games(user_id,game_id) VALUES(user_b,manual_game);
        RAISE EXCEPTION 'Another user could reference a private manual game';
    EXCEPTION WHEN check_violation THEN checks_passed:=checks_passed+1;
    END;

    -- This checks SQL merge behaviour, not the still-unimplemented Steam service.
    INSERT INTO public.user_games(user_id,game_id,playtime_minutes)
    VALUES(user_a,shared_game,240)
    ON CONFLICT(user_id,game_id) DO UPDATE
        SET playtime_minutes=EXCLUDED.playtime_minutes;
    IF NOT EXISTS (
        SELECT 1 FROM public.user_games
        WHERE id=entry_a AND status='completed' AND rating=8
          AND notes='Keep this note' AND completed_at=CURRENT_DATE
          AND playtime_minutes=240 AND updated_at>=before_update
    ) THEN RAISE EXCEPTION 'SQL time refresh lost personal fields'; END IF;
    checks_passed:=checks_passed+1;

    UPDATE public.user_games SET status='paused' WHERE id=entry_a;
    IF EXISTS(SELECT 1 FROM public.user_games WHERE id=entry_a AND completed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Completion date was not cleared after a status change';
    END IF;
    SELECT * INTO stats FROM public.user_statistics WHERE user_id=user_a;
    IF stats.completed_games<>0 OR stats.completion_percent<>0 OR stats.total_playtime_minutes<>300 THEN
        RAISE EXCEPTION 'Statistics were not recalculated after editing';
    END IF;
    checks_passed:=checks_passed+1;

    INSERT INTO public.steam_sync_runs(user_id,steam_id)
    VALUES(user_a,'76561198000000000') RETURNING id INTO sync_id;
    BEGIN
        INSERT INTO public.steam_sync_runs(user_id,steam_id)
        VALUES(user_a,'76561198000000000');
        RAISE EXCEPTION 'Concurrent running imports for one user were accepted';
    EXCEPTION WHEN unique_violation THEN checks_passed:=checks_passed+1;
    END;
    UPDATE public.steam_sync_runs
    SET status='success',finished_at=clock_timestamp() WHERE id=sync_id;
    INSERT INTO public.steam_sync_runs(user_id,steam_id)
    VALUES(user_a,'76561198000000000');
    checks_passed:=checks_passed+1;

    RAISE NOTICE 'PASS: % schema and data-integrity checks; test rows will be rolled back',checks_passed;
END
$tests$;

ROLLBACK;

SELECT current_database() AS database_name, 'Schema checks completed; inspect NOTICE for PASS' AS result;
