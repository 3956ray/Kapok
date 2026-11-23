CREATE TABLE profile_avatars (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
    digest TEXT NOT NULL CHECK(length(digest)=64),
    image TEXT NOT NULL CHECK(length(image) BETWEEN 1 AND 410000)
);
