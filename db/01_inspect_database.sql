SELECT current_database() AS database_name, 'users' AS object_name,
       'TABLE' AS object_type, count(*) AS row_count FROM public.users
UNION ALL
SELECT current_database(), 'games', 'TABLE', count(*) FROM public.games
UNION ALL
SELECT current_database(), 'user_games', 'TABLE', count(*) FROM public.user_games
UNION ALL
SELECT current_database(), 'sessions', 'TABLE', count(*) FROM public.sessions
UNION ALL
SELECT current_database(), 'steam_sync_runs', 'TABLE', count(*) FROM public.steam_sync_runs
UNION ALL
SELECT current_database(), 'user_statistics', 'VIEW', count(*) FROM public.user_statistics;
