from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    mapbox_access_token: str = ""

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
