import React, { useState, useEffect } from 'react';
import { 
  Plus, 
  Trash2, 
  Filter, 
  X, 
  Save, 
  FolderHeart,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Sliders,
  HelpCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { settingsService } from '../services/settingsService';
import { userService } from '../services/userService';
import { MOCK_DROPDOWNS } from '../mock/data';
import { Lead } from '../types';

export interface FilterRule {
  id: string;
  field: string;
  operator: 'contains' | 'equals' | 'not_equals' | 'starts_with' | 'ends_with' | 'is_empty' | 'is_not_empty' | 'gt' | 'lt';
  value: string;
}

export interface SavedPreset {
  id: string;
  name: string;
  matchType: 'AND' | 'OR';
  rules: FilterRule[];
}

export const FILTER_FIELDS = [
  { value: 'prospectName', label: 'Prospect Name', type: 'string' },
  { value: 'mobile', label: 'Mobile Number', type: 'string' },
  { value: 'area', label: 'Area / Region', type: 'select', category: 'Area' },
  { value: 'source', label: 'Lead Source', type: 'select', category: 'Source' },
  { value: 'currentStatus', label: 'Operational Status', type: 'select', category: 'FollowUpStatus' },
  { value: 'productName', label: 'Product Name', type: 'select', category: 'Product' },
  { value: 'campaignName', label: 'Campaign Funnel', type: 'select', category: 'Campaign' },
  { value: 'profession', label: 'Profession', type: 'select', category: 'Profession' },
  { value: 'assignedTo', label: 'Assigned User (Emp ID)', type: 'select', category: 'Users' },
  { value: 'collectedNCP', label: 'Collected NCP (৳)', type: 'number' },
  { value: 'projectedNCP', label: 'Projected NCP (৳)', type: 'number' },
  { value: 'sumAssured', label: 'Sum Assured (৳)', type: 'number' },
  { value: 'creationDate', label: 'Creation Date', type: 'date' },
  { value: 'nextFollowUpDate', label: 'Next Follow-up Date', type: 'date' }
];

interface AdvancedFilterPanelProps {
  onFilterChange: (filteredLeads: Lead[]) => void;
  allLeads: Lead[];
  className?: string;
}

export default function AdvancedFilterPanel({ onFilterChange, allLeads, className }: AdvancedFilterPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [matchType, setMatchType] = useState<'AND' | 'OR'>('AND');
  const [rules, setRules] = useState<FilterRule[]>([]);
  const [dropdownOptions, setDropdownOptions] = useState<Record<string, string[]>>({});
  const [users, setUsers] = useState<Array<{ employeeId: string, name: string, role: string }>>([]);
  const [presets, setPresets] = useState<SavedPreset[]>([]);
  const [newPresetName, setNewPresetName] = useState('');
  const [showSavePreset, setShowSavePreset] = useState(false);

  // Load dropdown options & active team members on mount
  useEffect(() => {
    async function loadDataAndOptions() {
      const options: Record<string, string[]> = {};
      const categories = ['Area', 'Source', 'Product', 'Campaign', 'Profession', 'FollowUpStatus'];
      
      for (const cat of categories) {
        try {
          const res = await settingsService.getOptionsByType(cat);
          options[cat] = res && res.length > 0 ? res : (MOCK_DROPDOWNS as any)[cat] || [];
        } catch (e) {
          options[cat] = (MOCK_DROPDOWNS as any)[cat] || [];
        }
      }
      setDropdownOptions(options);

      // Load Users for assignedTo dropdown options
      try {
        const usersList = await userService.getAllUsers();
        setUsers(usersList.map(u => ({
          employeeId: u.employeeId,
          name: u.name,
          role: u.role
        })));
      } catch (err) {
        console.error('Failed to load users for filter suggestions', err);
      }
    }

    loadDataAndOptions();

    // Load filter preset list from localStorage
    try {
      const saved = localStorage.getItem('lead_filter_presets');
      if (saved) {
        setPresets(JSON.parse(saved));
      }
    } catch (e) {
      console.error('Failed to parse filter presets', e);
    }
  }, []);

  // Run filtering logic whenever rules, matchType or allLeads change
  useEffect(() => {
    if (rules.length === 0) {
      onFilterChange(allLeads);
      return;
    }

    const filtered = allLeads.filter(lead => {
      const results = rules.map(rule => {
        const fieldConfig = FILTER_FIELDS.find(f => f.value === rule.field);
        if (!fieldConfig) return true;

        let val: any = lead[rule.field as keyof Lead];
        
        // Mobile fallback
        if (rule.field === 'mobile' && typeof val === 'undefined') {
          val = lead.mobileNumber;
        }

        const ruleVal = rule.value.toLowerCase().trim();
        const normVal = String(val || '').toLowerCase().trim();

        // Handle is empty check for all fields
        if (rule.operator === 'is_empty') {
          return !val || normVal === '';
        }
        if (rule.operator === 'is_not_empty') {
          return !!val && normVal !== '';
        }

        if (fieldConfig.type === 'number') {
          const numVal = parseFloat(val) || 0;
          const numRuleVal = parseFloat(rule.value) || 0;

          switch (rule.operator) {
            case 'equals': return numVal === numRuleVal;
            case 'not_equals': return numVal !== numRuleVal;
            case 'gt': return numVal > numRuleVal;
            case 'lt': return numVal < numRuleVal;
            default: return true;
          }
        }

        if (fieldConfig.type === 'date') {
          if (!val) return false;
          
          // Format date string to compare (YYYY-MM-DD)
          const dateStr = new Date(val).toISOString().split('T')[0];
          const testStr = rule.value; // expected is 'YYYY-MM-DD' from HTML input

          switch (rule.operator) {
            case 'equals': return dateStr === testStr;
            case 'gt': return new Date(dateStr) > new Date(testStr);
            case 'lt': return new Date(dateStr) < new Date(testStr);
            default: return true;
          }
        }

        // Standard string comparisons
        switch (rule.operator) {
          case 'equals':
            return normVal === ruleVal;
          case 'not_equals':
            return normVal !== ruleVal;
          case 'starts_with':
            return normVal.startsWith(ruleVal);
          case 'ends_with':
            return normVal.endsWith(ruleVal);
          case 'contains':
          default:
            return normVal.includes(ruleVal);
        }
      });

      if (matchType === 'AND') {
        return results.every(r => r === true);
      } else {
        return results.some(r => r === true);
      }
    });

    onFilterChange(filtered);
  }, [rules, matchType, allLeads]);

  const addRule = () => {
    const defaultField = FILTER_FIELDS[0];
    const newRule: FilterRule = {
      id: `rule_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      field: defaultField.value,
      operator: 'contains',
      value: ''
    };
    setRules([...rules, newRule]);
  };

  const removeRule = (id: string) => {
    setRules(rules.filter(r => r.id !== id));
  };

  const updateRule = (id: string, updates: Partial<FilterRule>) => {
    setRules(rules.map(r => {
      if (r.id !== id) return r;
      
      const nextRule = { ...r, ...updates };

      // Reset operators and value if field type has changed
      if (updates.field) {
        const nextFieldConfig = FILTER_FIELDS.find(f => f.value === updates.field);
        if (nextFieldConfig) {
          if (nextFieldConfig.type === 'number') {
            nextRule.operator = 'gt';
            nextRule.value = '0';
          } else if (nextFieldConfig.type === 'select') {
            nextRule.operator = 'equals';
            nextRule.value = '';
          } else if (nextFieldConfig.type === 'date') {
            nextRule.operator = 'equals';
            nextRule.value = new Date().toISOString().split('T')[0];
          } else {
            nextRule.operator = 'contains';
            nextRule.value = '';
          }
        }
      }
      return nextRule;
    }));
  };

  const clearAllRules = () => {
    setRules([]);
    setNewPresetName('');
    setShowSavePreset(false);
  };

  const savePreset = () => {
    if (!newPresetName.trim()) return;
    const newPreset: SavedPreset = {
      id: `preset_${Date.now()}`,
      name: newPresetName.trim(),
      matchType,
      rules
    };

    const updatedPresets = [...presets, newPreset];
    setPresets(updatedPresets);
    localStorage.setItem('lead_filter_presets', JSON.stringify(updatedPresets));
    setNewPresetName('');
    setShowSavePreset(false);
  };

  const loadPreset = (preset: SavedPreset) => {
    setMatchType(preset.matchType);
    setRules(preset.rules);
  };

  const deletePreset = (presetId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updatedPresets = presets.filter(p => p.id !== presetId);
    setPresets(updatedPresets);
    localStorage.setItem('lead_filter_presets', JSON.stringify(updatedPresets));
  };

  const getOperatorsForField = (fieldName: string) => {
    const config = FILTER_FIELDS.find(f => f.value === fieldName);
    if (!config) return [];

    if (config.type === 'number') {
      return [
        { value: 'gt', label: 'Is Greater Than (>' },
        { value: 'lt', label: 'Is Less Than (<)' },
        { value: 'equals', label: 'Equals' },
        { value: 'not_equals', label: 'Does Not Equal' },
        { value: 'is_empty', label: 'Is Empty' },
        { value: 'is_not_empty', label: 'Is Not Empty' }
      ];
    }

    if (config.type === 'date') {
      return [
        { value: 'equals', label: 'Is On (Date)' },
        { value: 'gt', label: 'Is After (Date)' },
        { value: 'lt', label: 'Is Before (Date)' },
        { value: 'is_empty', label: 'Is Empty' },
        { value: 'is_not_empty', label: 'Is Not Empty' }
      ];
    }

    if (config.type === 'select') {
      return [
        { value: 'equals', label: 'Equals' },
        { value: 'not_equals', label: 'Does Not Equal' },
        { value: 'is_empty', label: 'Is Empty' },
        { value: 'is_not_empty', label: 'Is Not Empty' }
      ];
    }

    return [
      { value: 'contains', label: 'Contains' },
      { value: 'equals', label: 'Equals' },
      { value: 'not_equals', label: 'Does Not Equal' },
      { value: 'starts_with', label: 'Starts With' },
      { value: 'ends_with', label: 'Ends With' },
      { value: 'is_empty', label: 'Is Empty' },
      { value: 'is_not_empty', label: 'Is Not Empty' }
    ];
  };

  return (
    <div className={`border border-slate-100 rounded-sm bg-white shadow-xs overflow-hidden ${className}`}>
      {/* Toggle Bar */}
      <button 
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-6 py-4 flex items-center justify-between bg-slate-50 border-b border-slate-100 font-black text-[11px] uppercase tracking-[0.15em] text-slate-800 hover:bg-slate-100 transition-colors cursor-pointer"
        id="btn-advanced-filter-toggle"
      >
        <span className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-[#978C21]" />
          Advanced Query & Segment Engine
          {rules.length > 0 && (
            <span className="ml-2 px-2 py-0.5 bg-[#978C21] text-white text-[9px] rounded-full normal-case font-black">
              {rules.length} active rule{rules.length > 1 ? 's' : ''}
            </span>
          )}
        </span>
        {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="p-6 md:p-8 space-y-6 bg-white italic border-b border-slate-50">
              
              {/* Preset Selector */}
              {presets.length > 0 && (
                <div className="space-y-2">
                  <span className="text-[10px] uppercase tracking-widest text-slate-400 font-extrabold flex items-center gap-1">
                    <FolderHeart className="w-3.5 h-3.5 text-[#978C21]" /> Saved Filter Segments
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {presets.map(p => (
                      <div 
                        key={p.id}
                        onClick={() => loadPreset(p)}
                        className="inline-flex items-center gap-2 px-3 py-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-sm cursor-pointer transition-colors group"
                      >
                        <span className="text-[10px] font-black uppercase text-slate-700 tracking-wider">
                          {p.name}
                        </span>
                        <span className="text-[8px] bg-slate-200 px-1 py-0.2 rounded text-slate-500 font-bold">
                          {p.rules.length}R ({p.matchType})
                        </span>
                        <button
                          type="button"
                          onClick={(e) => deletePreset(p.id, e)}
                          className="text-slate-400 hover:text-red-500 p-0.5 transition-colors"
                          title="Delete Preset"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Rules builder row header */}
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-50 pb-3">
                  <div className="flex items-center gap-4">
                    <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">
                      Search Logic:
                    </span>
                    <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-sm border border-slate-200">
                      <button
                        type="button"
                        onClick={() => setMatchType('AND')}
                        className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-widest rounded-sm transition-all cursor-pointer ${
                          matchType === 'AND' 
                            ? 'bg-slate-900 text-white shadow-sm' 
                            : 'text-slate-400 hover:text-slate-700'
                        }`}
                      >
                        Match ALL (AND)
                      </button>
                      <button
                        type="button"
                        onClick={() => setMatchType('OR')}
                        className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-widest rounded-sm transition-all cursor-pointer ${
                          matchType === 'OR' 
                            ? 'bg-slate-900 text-white shadow-sm' 
                            : 'text-slate-400 hover:text-slate-700'
                        }`}
                      >
                        Match ANY (OR)
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={addRule}
                      className="px-3.5 py-2 bg-slate-100 hover:bg-[#978C21] hover:text-white border border-slate-200 rounded-sm text-[10px] font-black uppercase tracking-widest transition-colors flex items-center gap-1.5 cursor-pointer shadow-xs text-slate-700"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add Filter Condition
                    </button>
                    {rules.length > 0 && (
                      <button
                        type="button"
                        onClick={clearAllRules}
                        className="px-3.5 py-2 border border-slate-200 hover:bg-slate-50 rounded-sm text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-800 transition-colors flex items-center gap-1.5 cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Clear Filter
                      </button>
                    )}
                  </div>
                </div>

                {/* Filter list rules container */}
                {rules.length === 0 ? (
                  <div className="py-8 text-center text-slate-300 flex flex-col items-center gap-2 select-none border border-dashed border-slate-100 rounded-sm">
                    <Sliders className="w-8 h-8 text-slate-200" />
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] italic">No active search filters applied</p>
                    <p className="text-[9px] font-medium text-slate-400">Click the button above to add custom segment queries dynamically</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {rules.map((rule, idx) => {
                      const selectedFieldConfig = FILTER_FIELDS.find(f => f.value === rule.field);
                      const isDropdownField = selectedFieldConfig?.type === 'select';
                      const isDateField = selectedFieldConfig?.type === 'date';
                      const isNumericField = selectedFieldConfig?.type === 'number';
                      const isNoValueOperator = rule.operator === 'is_empty' || rule.operator === 'is_not_empty';

                      return (
                        <motion.div 
                          key={rule.id}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="grid grid-cols-1 md:grid-cols-12 gap-3 p-4 bg-[#FBFAF8] border border-slate-100 rounded-sm relative group items-center"
                        >
                          {/* Selector: Field */}
                          <div className="md:col-span-4 space-y-1">
                            <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest block">Query Field</label>
                            <select
                              value={rule.field}
                              onChange={(e) => updateRule(rule.id, { field: e.target.value })}
                              className="w-full bg-white border border-slate-200 text-[10px] font-black uppercase tracking-wide py-2 px-3 rounded-sm outline-none focus:ring-1 focus:ring-[#978C21]"
                            >
                              {FILTER_FIELDS.map(f => (
                                <option key={f.value} value={f.value}>{f.label}</option>
                              ))}
                            </select>
                          </div>

                          {/* Selector: Operator */}
                          <div className="md:col-span-3 space-y-1">
                            <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest block">Comparison</label>
                            <select
                              value={rule.operator}
                              onChange={(e) => updateRule(rule.id, { operator: e.target.value as any })}
                              className="w-full bg-white border border-slate-200 text-[10px] font-black uppercase tracking-wide py-2 px-3 rounded-sm outline-none focus:ring-1 focus:ring-[#978C21]"
                            >
                              {getOperatorsForField(rule.field).map(op => (
                                <option key={op.value} value={op.value}>{op.label}</option>
                              ))}
                            </select>
                          </div>

                          {/* Selector: Value (Show value input if operator requires it) */}
                          <div className="md:col-span-4 space-y-1">
                            {!isNoValueOperator && (
                              <>
                                <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest block">Target Value</label>
                                {isDropdownField ? (
                                  selectedFieldConfig?.category === 'Users' ? (
                                    <select
                                      value={rule.value}
                                      onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                                      className="w-full bg-white border border-slate-200 text-[10px] font-black uppercase tracking-wide py-2 px-3 rounded-sm outline-none focus:ring-1 focus:ring-[#978C21]"
                                    >
                                      <option value="">-- ANY ASSIGNEE --</option>
                                      {users.map(u => (
                                        <option key={u.employeeId} value={u.employeeId}>
                                          {u.role}: {u.name} ({u.employeeId})
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <select
                                      value={rule.value}
                                      onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                                      className="w-full bg-white border border-slate-200 text-[10px] font-black uppercase tracking-wide py-2 px-3 rounded-sm outline-none focus:ring-1 focus:ring-[#978C21]"
                                    >
                                      <option value="">-- CHOOSE CRITERIA --</option>
                                      {(dropdownOptions[selectedFieldConfig?.category || ''] || []).map(opt => (
                                        <option key={opt} value={opt}>{opt.toUpperCase()}</option>
                                      ))}
                                    </select>
                                  )
                                ) : isDateField ? (
                                  <input
                                    type="date"
                                    value={rule.value}
                                    onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                                    className="w-full bg-white border border-slate-200 text-[10px] font-black px-3 py-2 rounded-sm focus:ring-1 focus:ring-[#978C21] outline-none"
                                  />
                                ) : isNumericField ? (
                                  <input
                                    type="number"
                                    value={rule.value}
                                    onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                                    className="w-full bg-white border border-slate-200 text-[10px] font-black px-3 py-2 rounded-sm focus:ring-1 focus:ring-[#978C21] outline-none"
                                    placeholder="Number..."
                                  />
                                ) : (
                                  <input
                                    type="text"
                                    value={rule.value}
                                    onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                                    className="w-full bg-white border border-slate-200 text-[10px] font-semibold px-3 py-2 rounded-sm focus:ring-1 focus:ring-[#978C21] outline-none"
                                    placeholder="Search key..."
                                  />
                                )}
                              </>
                            )}
                          </div>

                          {/* Rule Close Button */}
                          <div className="md:col-span-1 text-center md:text-right pt-4 md:pt-0">
                            <button
                              type="button"
                              onClick={() => removeRule(rule.id)}
                              className="p-2 text-slate-400 hover:text-red-500 rounded-full hover:bg-red-50 transition-colors inline-block cursor-pointer"
                              title="Delete Rule"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Action Buttons to Save Rules as Presets */}
              {rules.length > 0 && (
                <div className="flex flex-col md:flex-row md:items-center justify-between border-t border-slate-50 pt-5 gap-4">
                  <div className="text-[9px] font-bold text-[#978C21] flex items-center gap-1">
                    <HelpCircle className="w-3.5 h-3.5" /> Leads matching this filter matrix will dynamically update across your display list modules.
                  </div>
                  <div>
                    {!showSavePreset ? (
                      <button
                        type="button"
                        onClick={() => setShowSavePreset(true)}
                        className="px-4 py-2 hover:bg-slate-50 border border-slate-200 text-[10px] font-black uppercase tracking-widest text-[#978C21] rounded-sm flex items-center gap-1.5 cursor-pointer shadow-xs"
                      >
                        <Save className="w-3.5 h-3.5 font-bold" />
                        Save This Segment Preset
                      </button>
                    ) : (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={newPresetName}
                          onChange={(e) => setNewPresetName(e.target.value)}
                          placeholder="PRESET SEGMENT NAME"
                          className="bg-[#FBFAF8] border border-slate-200 px-3 py-2 text-[10px] uppercase font-black tracking-wider outline-none rounded-sm placeholder:opacity-40"
                        />
                        <button
                          type="button"
                          onClick={savePreset}
                          disabled={!newPresetName.trim()}
                          className="px-3.5 py-2.5 bg-slate-900 border border-transparent text-white hover:bg-black text-[10px] font-black uppercase tracking-widest rounded-sm disabled:opacity-45 cursor-pointer"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowSavePreset(false)}
                          className="text-[9px] font-black uppercase text-slate-400 hover:text-slate-700 px-2 tracking-widest cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
