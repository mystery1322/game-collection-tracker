-- Template used by scripts/setup-local.js. Execute the generated file in game_collection.
BEGIN;
DO $role$
BEGIN
    IF current_database() <> 'game_collection' THEN
        RAISE EXCEPTION 'Select game_collection before creating the application role';
    END IF;
END
$role$;
CREATE ROLE game_collection_app LOGIN PASSWORD '__SCRAM_VERIFIER__';
GRANT CONNECT ON DATABASE game_collection TO game_collection_app;
GRANT USAGE ON SCHEMA public TO game_collection_app;
GRANT SELECT, INSERT, UPDATE ON users, steam_sync_runs TO game_collection_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON games, user_games, sessions TO game_collection_app;
GRANT SELECT ON user_statistics TO game_collection_app;
GRANT USAGE ON SEQUENCE users_id_seq, games_id_seq, user_games_id_seq, steam_sync_runs_id_seq TO game_collection_app;
COMMIT;
