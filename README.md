# Clock Weather Card - Custom

A custom fork of [pkissling/clock-weather-card](https://github.com/pkissling/clock-weather-card).

[![Current version](https://img.shields.io/github/v/release/tc-fpv/clock-weather-card-custom)](https://github.com/tc-fpv/clock-weather-card-custom/releases/latest)

A [Home Assistant Dashboard Card](https://www.home-assistant.io/dashboards/) showing the current date, time and a weather forecast.
It can be installed as a custom repository through HACS / the Home Assistant Marketplace.

![Clock Weather Card](.github/assets/card.gif)
[^1]

Credits go to [basmilius](https://github.com/basmilius) for the awesome [weather icons](https://github.com/basmilius/weather-icons).

## Additions in this fork

* **Wind:** `wind_speed_sensor` and `wind_direction_sensor` add the current wind speed and compass direction to the weather line.
* **Rain rate:** `rain_rate_sensor` shows `Rain: x mm/h` in the today section, only while the rate is above zero.
* **Met Office weather warnings:** see [Weather warnings](#weather-warnings).
* The card type is `custom:clock-weather-card-custom`, so it can sit alongside the original card.

## Weather warnings

The card can show [Met Office weather warnings](https://www.metoffice.gov.uk/weather/warnings-and-advice/uk-warnings) without changing the size of the card.
It reads a [feedparser](https://github.com/custom-components/feedparser) sensor that tracks a Met Office warnings RSS feed
(for example `https://www.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/nw`), using the sensor's `entries` attribute.

While a warning is active:

* The weather icon is replaced by a warning triangle coloured by severity: yellow, amber or red.
* The weather, temperature and wind text line is replaced by the warning, for example `Yellow Warning - Snow`.
  If several warnings match, the highest severity is shown with a count of the others, for example `Amber Warning - Wind (+1)`.
* Tapping the triangle dismisses the warning (see `warning_dismiss_entity`). The normal weather icon and text return.
* The clock, date, forecast and any humidity, feels-like, AQI and rain rate lines are unchanged.

Severity and type are read from the warning's image name (for example `yellow-snow.png`). Every entry the feed returns is treated as active; validity times are not parsed.

### Choosing `warning_areas`

The Met Office lists affected areas by local authority (county or unitary authority), not by town.
An area is listed if the warning touches any part of it, so a warning that lists a county may not reach every part of that county.
Unitary authorities such as Blackpool are listed separately from the county they sit in (Lancashire),
so `warning_areas: [Lancashire]` can match warnings that do not reach Blackpool.
Use the area name closest to you. Matching is a case-insensitive text match against the warning title and summary.

### Resetting a dismissed warning

Create an `input_boolean` helper and set it as `warning_dismiss_entity`. Tapping the icon turns it on, which hides the warning.
Add an automation that turns it off when the feed sensor changes, so the next new warning is shown:

```yaml
alias: Reset weather warning dismissal
triggers:
  - trigger: state
    entity_id: sensor.met_office_warnings_nw
actions:
  - action: input_boolean.turn_off
    target:
      entity_id: input_boolean.weather_alert_dismissed
```

### Example

```yaml
type: custom:clock-weather-card-custom
entity: weather.home
warning_sensor: sensor.met_office_warnings_nw
warning_areas:
  - Blackpool
warning_dismiss_entity: input_boolean.weather_alert_dismissed
```

## FAQ

* [Why don't I see the current day in my weather forecast?](#why-dont-i-see-the-current-day-in-my-weather-forecast)
* [What does the card actually display?](#what-does-the-card-actually-display)

### Why don't I see the current day in my weather forecast?

Your weather provider may not provide today's weather as part of their weather forecast. You may consider switching to a different weather provider.
[Open Meteo](https://www.home-assistant.io/integrations/open_meteo/) is the default weather integrations in home assistant and providings today's weather.

### What does the card actually display?

![image](https://user-images.githubusercontent.com/33731393/221779555-c2c25e12-4ff0-4c61-8fd7-94d5b1b214d3.png)

The bars represent the temperature range for a given day.
In the above image, the 9° on Thursday represents the low across all of the forecast days and the 21° represents the highs (i.e. all bars are from 9° to 21°).
The colored portion of the bar represents the range of temperatures that are forecast for that day (so 12° to 21° on Monday).
The circle represents the current temperature (16° or roughly midway between 12° and 21° in your case).

_Thanks to @deprecatedcoder for this text from [#143](https://github.com/pkissling/clock-weather-card/issues/143)_

The basic idea of the forecast bars is to be able to understand the weather trend for the upcoming days in a single glance.

## Installation

### Manual Installation

1. Download the [clock-weather-card.js](https://github.com/tc-fpv/clock-weather-card-custom/releases/latest/download/clock-weather-card.js) from the latest release.
2. Place the file in your Home Assistant's `config/www` folder.
3. Add the configuration to your `ui-lovelace.yaml`.

   ```yaml
   resources:
     - url: /local/clock-weather-card.js
       type: module
   ```

4. Add [configuration](#configuration) for the card in your `ui-lovelace.yaml`.

### Installation and tracking with HACS / Marketplace

1. Make sure [HACS](https://github.com/custom-components/hacs) (or, on Home Assistant 2026.11 and later, the built-in Marketplace) is installed and working.
2. Add `https://github.com/tc-fpv/clock-weather-card-custom` as a custom repository of type **Dashboard** (HACS) or via **Add from link** (Marketplace), then install **Clock Weather Card Custom**.
3. HACS and the Marketplace register the Lovelace resource for you when installing. If you manage resources in YAML, add it yourself:

   ```yaml
   resources:
     - url: /hacsfiles/clock-weather-card-custom/clock-weather-card.js
       type: module
   ```

4. Restart Home Assistant and hard-refresh your browser after installing or updating, so the new version is loaded.
5. Add [configuration](#configuration) for the card in your `ui-lovelace.yaml` or via the UI.

## Configuration

### Minimal configuration

```yaml
type: custom:clock-weather-card-custom
entity: weather.home  # replace with your weather providers's entity id
```

### Full configuration

```yaml
type: custom:clock-weather-card-custom
entity: weather.home  # replace with your weather providers's entity id
title: Home
sun_entity: sun.sun
temperature_sensor: sensor.outdoor_temp
humidity_sensor: sensor.outdoor_humidity
weather_icon_type: line
animated_icon: true
forecast_rows: 5
locale: en-GB
time_pattern: HH:mm
time_format: 24
date_pattern: ccc, d.MM.yy
hide_today_section: false
hide_forecast_section: false
show_humidity: false
hide_clock: false
hide_date: false
hourly_forecast: false
use_browser_time: false
time_zone: null
show_decimal: false
apparent_sensor: sensor.real_feel_temperature
aqi_sensor: sensor.air_quality_index
wind_speed_sensor: sensor.wind_speed
wind_direction_sensor: sensor.wind_direction
rain_rate_sensor: sensor.rain_rate
warning_sensor: sensor.met_office_warnings_nw
warning_areas:
  - Blackpool
warning_dismiss_entity: input_boolean.weather_alert_dismissed
```

### Options

| Name                  | Type             | Requirement  | Description                                                                                                                                                                                                                       | Default   |
| --------------------- | ---------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| type                  | string           | **Required** | `custom:clock-weather-card-custom`                                                                                                                                                                                                       |           |
| entity                | string           | **Required** | ID of the weather entity                                                                                                                                                                                                          |           |
| title                 | string           | **Optional** | Title of the card                                                                                                                                                                                                                 | `''`      |
| sun_entity            | boolean          | **Optional** | ID of the sun entity. Used to determine whether to show a day or night icon. If sun integration is not enabled, day icon will be shown                                                                                            | `sun.sun` |
| temperature_sensor    | string           | **Optional** | ID of the temperature sensor entity. Used to show the current temperature based on a sensor value instead of the weather forecast                                                                                                 | `''`      |
| humidity_sensor       | string           | **Optional** | ID of the humidity sensor entity. Used to show the current humidity based on a sensor value, if `show_humidity` is set to `true`                                                                                                  | `''`      |
| weather_icon_type     | `line` \| `fill` | **Optional** | Appearance of the large weather icon                                                                                                                                                                                              | `line`    |
| animated_icon         | boolean          | **Optional** | Whether the large weather icon should be animated                                                                                                                                                                                 | `true`    |
| forecast_rows         | number           | **Optional** | The amount of weather forecast rows to show. Depending on `hourly_forecast` each row either corresponds to a day or an hour                                                                                                       | `5`       |
| locale                | string[^2]       | **Optional** | Language to use for language specific text and date/time formatting. If not provided, falls back to the locale set in HA or, if not set in HA, to `en-GB`                                                                         | `en-GB`   |
| time_format           | `24` \| `12`     | **Optional** | Format used to display the time. If not provided, falls back to the default time format of the configured `locale`.  This option is ignored if `time_pattern` is set.                                                             | `24`      |
| time_pattern          | string           | **Optional** | Pattern to use for time formatting. See [luxon](https://moment.github.io/luxon/#/formatting?id=table-of-tokens) for valid tokens. If not provided, falls back to time_format option.                                              | `null`    |
| date_pattern          | string           | **Optional** | Pattern to use for date formatting. If not provided, falls back to a localized default date formatting. See [luxon](https://moment.github.io/luxon/#/formatting?id=table-of-tokens) for valid tokens                              | `D`       |
| show_humidity         | boolean          | **Optional** | Shows the humidity in the today section. Reads the value from `humidity_sensor`, if provided, otherwise from the `humidity` attribute of the configured weather `entity`                                                           | `false`   |
| hide_today_section    | boolean          | **Optional** | Hides the cards today section (upper section), containing the large weather icon, clock and current date                                                                                                                          | `false`   |
| hide_forecast_section | boolean          | **Optional** | Hides the cards forecast section (lower section),containing the weather forecast                                                                                                                                                  | `false`   |
| hide_clock            | boolean          | **Optional** | Hides the clock from the today section and prominently displays the current temperature instead                                                                                                                                   | `false`   |
| hide_date             | boolean          | **Optional** | Hides the date from the today section                                                                                                                                                                                             | `false`   |
| hourly_forecast       | boolean          | **Optional** | Displays an hourly forecast instead of daily                                                                                                                                                                                      | `false`   |
| use_browser_time      | boolean          | **Optional** | Uses the time from your browser to indicate the current time. If not provided, uses the [time_zone](https://www.home-assistant.io/blog/2015/05/09/utc-time-zone-awareness/#setting-up-your-time-zone) configured in HA            | `false`   |
| time_zone             | string           | **Optional** | Uses the given [time zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) to indicate the current date and time. If not provided, uses the time zone configured in HA                                              | `null`    |
| show_decimal          | boolean          | **Optional** | Displays main temperature without rounding                                                                                                                                                                                        | `false`   |
| apparent_sensor       | string           | **Optional** | ID of the apparent temperature sensor entity. It is used to show the apparent temperature based on a sensor and will only show it if value is provided.                                                                           | `''`      |
| aqi_sensor            | string           | **Optional** | ID of the Air Quality Index sensor entity. It is used to show the AQI based on a sensor and will only show it if value is provided.                                                                                               | `''`      |
| wind_speed_sensor     | string           | **Optional** | ID of the wind speed sensor entity. When configured, appends the wind speed (with unit) to the weather state line, e.g. `Cloudy, 14°, 12 mph NW`. Hidden while a warning is shown.                                       | `''`      |
| wind_direction_sensor | string           | **Optional** | ID of the wind direction sensor entity. Accepts a numeric bearing (degrees, converted to a 16-point compass abbreviation) or a string abbreviation (e.g. `NW`). Displayed alongside wind speed on the weather state line.         | `''`      |
| rain_rate_sensor      | string           | **Optional** | ID of the rain rate sensor entity (mm/h). When the value is above zero, `Rain: x mm/h` is shown in the today section.                                                                                                             | `''`      |
| warning_sensor        | string           | **Optional** | ID of a [feedparser](https://github.com/custom-components/feedparser) sensor tracking a Met Office warnings RSS feed. When it has matching entries, the weather icon and text line are replaced by the highest severity warning. See [Weather warnings](#weather-warnings). | `''`      |
| warning_areas         | string[]         | **Optional** | Only warnings whose title or summary mention one of these names (case-insensitive, e.g. `Blackpool`) are shown. The feed lists counties and unitary authorities, not towns. If empty, all entries are shown.                      | `[]`      |
| warning_dismiss_entity | string          | **Optional** | ID of an `input_boolean`. Tapping the warning icon turns it on and hides the warning while it is on. Reset it with an automation when the feed sensor changes so the next warning is shown.                                       | `''`      |

## Footnotes

[^1]: Theme used: [lovelace-ios-themes](https://github.com/basnijholt/lovelace-ios-themes).
[^2]: Supported languages: `ar`, `bg`, `ca`, `cs`, `cy`, `da`, `de`, `el`,`en`, `es`, `et`, `fi`, `fr`, `he`, `hu`, `hr`, `id`, `is`, `it`, `ja`, `ko`, `lb`, `lt`, `nb`, `nl`, `pl`, `pt`, `pt-BR`, `ro`, `ru`, `sk`, `sl`, `sr`, `sr-Latn`, `sv`, `th`, `tr`, `uk`, `ur`, `vi`, `zh-CN`, `zh-TW`
