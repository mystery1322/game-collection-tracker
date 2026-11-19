-- Initial schema. Run once against game_collection as the schema owner.
-- An unexpected existing object causes a transaction rollback, not replacement.
BEGIN;

DO $guard$
BEGIN
    IF current_database() <> 'game_collection' THEN
        RAISE EXCEPTION 'Select game_collection before running this migration';
    END IF;
END
$guard$;

CREATE TABLE public.users (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email varchar(254) NOT NULL,
    password_hash text NOT NULL,
    display_name varchar(80) NOT NULL,
    steam_id varchar(17),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_email_not_blank CHECK (
        email = btrim(email) AND char_length(email) BETWEEN 3 AND 254
    ),
    CONSTRAINT users_password_hash_length CHECK (
        char_length(password_hash) BETWEEN 32 AND 1024
    ),
    CONSTRAINT users_display_name_not_blank CHECK (
        char_length(btrim(display_name)) BETWEEN 1 AND 80
    ),
    CONSTRAINT users_steam_id_format CHECK (steam_id ~ '^[0-9]{17}$')
);

CREATE UNIQUE INDEX users_email_case_insensitive_uq ON public.users (lower(email));

CREATE TABLE public.games (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    steam_app_id bigint UNIQUE,
    title varchar(255) NOT NULL,
    icon_url text,
    created_by integer REFERENCES public.users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT games_title_not_blank CHECK (char_length(btrim(title)) BETWEEN 1 AND 255),
    CONSTRAINT games_steam_app_id_range CHECK (steam_app_id BETWEEN 1 AND 4294967295),
    CONSTRAINT games_source CHECK (
        (steam_app_id IS NOT NULL AND created_by IS NULL)
        OR (steam_app_id IS NULL AND created_by IS NOT NULL)
    )
);

CREATE INDEX games_created_by_idx ON public.games (created_by)
    WHERE created_by IS NOT NULL;

CREATE TABLE public.user_games (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    game_id integer NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
    status varchar(16) NOT NULL DEFAULT 'planned',
    playtime_minutes integer NOT NULL DEFAULT 0,
    rating smallint,
    notes varchar(2000) NOT NULL DEFAULT '',
    completed_at date,
    added_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_games_user_game_uq UNIQUE (user_id, game_id),
    CONSTRAINT user_games_status CHECK (
        status IN ('planned', 'playing', 'completed', 'paused', 'dropped')
    ),
    CONSTRAINT user_games_playtime_nonnegative CHECK (playtime_minutes >= 0),
    CONSTRAINT user_games_rating_range CHECK (rating BETWEEN 1 AND 10),
    CONSTRAINT user_games_completion_status CHECK (
        completed_at IS NULL OR status = 'completed'
    )
);

CREATE INDEX user_games_game_id_idx ON public.user_games (game_id);
CREATE INDEX user_games_user_status_idx ON public.user_games (user_id, status);
CREATE INDEX user_games_user_playtime_idx
    ON public.user_games (user_id, playtime_minutes DESC, id);

-- CURRENT_DATE is checked on writes rather than placed in a time-dependent CHECK.
-- API authorization must still verify the authenticated user on every request.
CREATE FUNCTION public.prepare_user_game() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
DECLARE
    manual_owner integer;
BEGIN
    SELECT g.created_by INTO manual_owner
    FROM public.games AS g WHERE g.id = NEW.game_id;

    IF manual_owner IS NOT NULL AND manual_owner <> NEW.user_id THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'A manually added game belongs to its creator',
            CONSTRAINT = 'user_games_manual_owner';
    END IF;

    IF NEW.status <> 'completed' THEN
        NEW.completed_at := NULL;
    END IF;

    IF NEW.completed_at > CURRENT_DATE THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'Completion date cannot be in the future',
            CONSTRAINT = 'user_games_completion_not_future';
    END IF;

    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END
$function$;

CREATE TRIGGER user_games_prepare_before_write
BEFORE INSERT OR UPDATE ON public.user_games
FOR EACH ROW EXECUTE FUNCTION public.prepare_user_game();

-- Compatible with connect-pg-simple when configured with tableName: 'sessions'.
CREATE TABLE public.sessions (
    sid varchar NOT NULL PRIMARY KEY,
    sess json NOT NULL,
    expire timestamp(6) without time zone NOT NULL
);
CREATE INDEX sessions_expire_idx ON public.sessions (expire);

CREATE TABLE public.steam_sync_runs (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    steam_id varchar(17) NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'running',
    added_count integer NOT NULL DEFAULT 0,
    updated_count integer NOT NULL DEFAULT 0,
    error_code varchar(80),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    CONSTRAINT steam_sync_runs_steam_id_format CHECK (steam_id ~ '^[0-9]{17}$'),
    CONSTRAINT steam_sync_runs_status CHECK (status IN ('running', 'success', 'failed')),
    CONSTRAINT steam_sync_runs_counts CHECK (added_count >= 0 AND updated_count >= 0),
    CONSTRAINT steam_sync_runs_finished_state CHECK (
        (status = 'running' AND finished_at IS NULL)
        OR (status <> 'running' AND finished_at IS NOT NULL)
    ),
    CONSTRAINT steam_sync_runs_finished_time CHECK (finished_at >= started_at),
    CONSTRAINT steam_sync_runs_error_state CHECK (
        (status = 'failed' AND error_code IS NOT NULL)
        OR (status <> 'failed' AND error_code IS NULL)
    )
);

CREATE UNIQUE INDEX steam_sync_runs_one_running_per_user_uq
    ON public.steam_sync_runs (user_id) WHERE status = 'running';
CREATE INDEX steam_sync_runs_user_status_started_idx
    ON public.steam_sync_runs (user_id, status, started_at DESC);

CREATE VIEW public.user_statistics AS
SELECT
    u.id AS user_id,
    count(ug.id) AS total_games,
    count(ug.id) FILTER (WHERE ug.status = 'planned') AS planned_games,
    count(ug.id) FILTER (WHERE ug.status = 'playing') AS playing_games,
    count(ug.id) FILTER (WHERE ug.status = 'completed') AS completed_games,
    count(ug.id) FILTER (WHERE ug.status = 'paused') AS paused_games,
    count(ug.id) FILTER (WHERE ug.status = 'dropped') AS dropped_games,
    coalesce(sum(ug.playtime_minutes), 0) AS total_playtime_minutes,
    round(avg(ug.rating), 2) AS average_rating,
    coalesce(round(
        100.0 * count(ug.id) FILTER (WHERE ug.status = 'completed')
        / nullif(count(ug.id), 0), 2
    ), 0.00) AS completion_percent
FROM public.users AS u
LEFT JOIN public.user_games AS ug ON ug.user_id = u.id
GROUP BY u.id;

COMMENT ON TABLE public.users IS 'Application accounts; never plaintext passwords';
COMMENT ON TABLE public.games IS 'Shared Steam games or privately authored manual games';
COMMENT ON TABLE public.user_games IS 'Personal game status, time, rating and notes';
COMMENT ON TABLE public.sessions IS 'Server-side Express sessions; not application passwords';
COMMENT ON TABLE public.steam_sync_runs IS 'Steam import results without API keys or response payloads';
COMMENT ON VIEW public.user_statistics IS 'Statistics calculated from the current collection';

COMMIT;
