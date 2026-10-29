import * as Array from 'effect/Array'
import * as Option from 'effect/Option'

export const defaultCountryIso = 'NL'

export type FlagMark =
  | {
      readonly kind: 'bands'
      readonly axis: 'x' | 'y'
      readonly colors: ReadonlyArray<string>
    }
  | {
      readonly kind: 'cross'
      readonly field: string
      readonly cross: string
    }
  | {
      readonly kind: 'nordic'
      readonly field: string
      readonly cross: string
      readonly outline?: string
    }
  | {
      readonly kind: 'disc'
      readonly field: string
      readonly disc: string
    }
  | {
      readonly kind: 'canton'
      readonly stripe: string
      readonly gap: string
      readonly canton: string
    }
  | {
      readonly kind: 'union'
    }

export type Country = {
  readonly iso: string
  readonly name: string
  readonly dial: string
  readonly flag: FlagMark
}

export const countries: ReadonlyArray<Country> = [
  {
    iso: 'AT',
    name: 'Austria',
    dial: '+43',
    flag: { kind: 'bands', axis: 'y', colors: ['#ED2939', '#FFFFFF', '#ED2939'] },
  },
  {
    iso: 'BE',
    name: 'Belgium',
    dial: '+32',
    flag: { kind: 'bands', axis: 'x', colors: ['#000000', '#FAE042', '#ED2939'] },
  },
  {
    iso: 'DK',
    name: 'Denmark',
    dial: '+45',
    flag: { kind: 'nordic', field: '#C8102E', cross: '#FFFFFF' },
  },
  {
    iso: 'FI',
    name: 'Finland',
    dial: '+358',
    flag: { kind: 'nordic', field: '#FFFFFF', cross: '#003580' },
  },
  {
    iso: 'FR',
    name: 'France',
    dial: '+33',
    flag: { kind: 'bands', axis: 'x', colors: ['#0055A4', '#FFFFFF', '#EF4135'] },
  },
  {
    iso: 'DE',
    name: 'Germany',
    dial: '+49',
    flag: { kind: 'bands', axis: 'y', colors: ['#000000', '#DD0000', '#FFCE00'] },
  },
  {
    iso: 'GR',
    name: 'Greece',
    dial: '+30',
    flag: { kind: 'bands', axis: 'y', colors: ['#0D5EAF', '#FFFFFF', '#0D5EAF'] },
  },
  {
    iso: 'HU',
    name: 'Hungary',
    dial: '+36',
    flag: { kind: 'bands', axis: 'y', colors: ['#CE2939', '#FFFFFF', '#477050'] },
  },
  {
    iso: 'IE',
    name: 'Ireland',
    dial: '+353',
    flag: { kind: 'bands', axis: 'x', colors: ['#169B62', '#FFFFFF', '#FF883E'] },
  },
  {
    iso: 'IT',
    name: 'Italy',
    dial: '+39',
    flag: { kind: 'bands', axis: 'x', colors: ['#009246', '#FFFFFF', '#CE2B37'] },
  },
  {
    iso: 'JP',
    name: 'Japan',
    dial: '+81',
    flag: { kind: 'disc', field: '#FFFFFF', disc: '#BC002D' },
  },
  {
    iso: 'NL',
    name: 'Netherlands',
    dial: '+31',
    flag: { kind: 'bands', axis: 'y', colors: ['#AE1C28', '#FFFFFF', '#21468B'] },
  },
  {
    iso: 'NO',
    name: 'Norway',
    dial: '+47',
    flag: {
      kind: 'nordic',
      field: '#BA0C2F',
      cross: '#00205B',
      outline: '#FFFFFF',
    },
  },
  {
    iso: 'PL',
    name: 'Poland',
    dial: '+48',
    flag: { kind: 'bands', axis: 'y', colors: ['#FFFFFF', '#DC143C'] },
  },
  {
    iso: 'PT',
    name: 'Portugal',
    dial: '+351',
    flag: { kind: 'bands', axis: 'x', colors: ['#006600', '#FF0000'] },
  },
  {
    iso: 'ES',
    name: 'Spain',
    dial: '+34',
    flag: { kind: 'bands', axis: 'y', colors: ['#AA151B', '#F1BF00', '#AA151B'] },
  },
  {
    iso: 'SE',
    name: 'Sweden',
    dial: '+46',
    flag: { kind: 'nordic', field: '#006AA7', cross: '#FECC00' },
  },
  {
    iso: 'CH',
    name: 'Switzerland',
    dial: '+41',
    flag: { kind: 'cross', field: '#FF0000', cross: '#FFFFFF' },
  },
  {
    iso: 'UA',
    name: 'Ukraine',
    dial: '+380',
    flag: { kind: 'bands', axis: 'y', colors: ['#005BBB', '#FFD500'] },
  },
  {
    iso: 'GB',
    name: 'United Kingdom',
    dial: '+44',
    flag: { kind: 'union' },
  },
  {
    iso: 'US',
    name: 'United States',
    dial: '+1',
    flag: { kind: 'canton', stripe: '#B22234', gap: '#FFFFFF', canton: '#3C3B6E' },
  },
]

export const countryByIso = (iso: string): Option.Option<Country> =>
  Array.findFirst(countries, country => country.iso === iso)

export const dialFor = (iso: string): string =>
  Option.match(countryByIso(iso), {
    onNone: () => '+31',
    onSome: country => country.dial,
  })
