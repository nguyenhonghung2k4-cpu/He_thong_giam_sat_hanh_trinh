#pragma once
using esp_err_t=int;
constexpr esp_err_t ESP_OK=0,ESP_ERR_NO_MEM=0x101,ESP_ERR_INVALID_STATE=0x103,ESP_ERR_TIMEOUT=0x107;
inline const char *esp_err_to_name(esp_err_t e){return e==ESP_OK?"ESP_OK":e==ESP_ERR_NO_MEM?"ESP_ERR_NO_MEM":e==ESP_ERR_INVALID_STATE?"ESP_ERR_INVALID_STATE":"ESP_ERR_TIMEOUT";}
