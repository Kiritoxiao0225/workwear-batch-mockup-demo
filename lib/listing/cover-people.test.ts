import { describe, expect, it } from 'vitest';
import { BUILT_IN_LAYOUTS, coverPeopleOf, skuPair, withCover } from './templates';

const master = (id: string) => BUILT_IN_LAYOUTS.find(l => l.id === id)!;

describe('首图人物 (11-01)', () => {
  it("is the plan's choice, else the master's: 光影棚拍 one person, the lead; nobody on 产品静物", () => {
    expect(coverPeopleOf(master('M4'), { model: { lead: '女' } })).toBe('女');
    expect(coverPeopleOf(master('M4'), { model: { lead: '男' } })).toBe('男');
    expect(coverPeopleOf(master('M4'), { model: { lead: '女' }, coverPeople: '男女' })).toBe('男女');
    expect(coverPeopleOf(master('M5'), { model: { lead: '女' }, coverPeople: '男' })).toBeNull();
  });
  it('sets the cover template to one person or two, square and 3:4, and nothing else', () => {
    const two = withCover(master('M4'), { model: { lead: '女' }, coverPeople: '男女' });
    expect([two.templates.首图.square.people, two.templates.首图.portrait.people, skuPair(two)]).toEqual([2, 2, true]);
    expect(two.templates.功能).toBe(master('M4').templates.功能);
    const one = withCover(master('M1'), { model: { lead: '女' }, coverPeople: '男' });
    expect([one.templates.首图.square.people, skuPair(one)]).toEqual([1, false]);
    expect(withCover(master('M1'), { model: { lead: '女' } })).toBe(master('M1'));
    expect(withCover(master('M5'), { model: { lead: '女' }, coverPeople: '男女' })).toBe(master('M5'));
  });
});
