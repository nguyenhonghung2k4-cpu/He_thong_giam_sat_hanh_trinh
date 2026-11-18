#pragma once
using esp_err_t = int;
constexpr esp_err_t ESP_OK = 0;
constexpr esp_err_t ESP_ERR_INVALID_STATE = 1;
constexpr esp_err_t ESP_ERR_TIMEOUT = 2;
constexpr esp_err_t ESP_ERR_NO_MEM = 3;
inline const char *esp_err_to_name(esp_err_t e) {
  return e == ESP_OK ? "ESP_OK" : e == ESP_ERR_INVALID_STATE ? "ESP_ERR_INVALID_STATE" :
    e == ESP_ERR_TIMEOUT ? "ESP_ERR_TIMEOUT" : "ESP_ERR_NO_MEM";
}
