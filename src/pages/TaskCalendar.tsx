import React, { useEffect, useState } from 'react';
import { 
  Calendar as CalendarIcon, 
  ChevronLeft, 
  ChevronRight, 
  Clock, 
  User, 
  Phone, 
  Search, 
  SlidersHorizontal,
  Plus, 
  Sparkles,
  ExternalLink,
  MapPin,
  Tag,
  Layers,
  ArrowRight,
  Video,
  X,
  CheckCircle,
  HelpCircle,
  FileText
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../lib/utils';
import { useAuthStore } from '../store/authStore';
import { leadService } from '../services/leadService';
import { Lead, LeadStatus } from '../types';
import { useNavigate } from 'react-router-dom';

interface CalendarEvent {
  id: string;
  leadId: string;
  lead: Lead;
  type: 'call' | 'meeting' | 'followup';
  title: string;
  date: Date;
  dateStr: string; // ISO string
  remarks?: string;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function TaskCalendar({ embedded = false }: { embedded?: boolean } = {}) {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [filteredEvents, setFilteredEvents] = useState<CalendarEvent[]>([]);

  // Calendar State
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [viewMode, setViewMode] = useState<'year' | 'month' | 'week' | 'day'>('month');
  const [searchQuery, setSearchQuery] = useState('');
  
  // Event Type Filters
  const [filterTypes, setFilterTypes] = useState({
    call: true,
    meeting: true,
    followup: true
  });

  // Modal State
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [selectedDayEvents, setSelectedDayEvents] = useState<{ day: Date; events: CalendarEvent[] } | null>(null);

  useEffect(() => {
    const fetchLeadsAndBuildEvents = async () => {
      if (!user) return;
      setLoading(true);
      try {
        const fetchedLeads = await leadService.getLeads({ 
          employeeId: user.employeeId, 
          role: user.role 
        });
        setLeads(fetchedLeads);

        // Map leads to calendar events
        const mappedEvents: CalendarEvent[] = [];

        fetchedLeads.forEach(lead => {
          // 1. Next Call Date
          if (lead.nextCallDate) {
            mappedEvents.push({
              id: `${lead.id}_call_${lead.nextCallDate}`,
              leadId: lead.id,
              lead,
              type: 'call',
              title: `Call Scheduled: ${lead.prospectName}`,
              date: new Date(lead.nextCallDate),
              dateStr: lead.nextCallDate,
              remarks: lead.otherInfo
            });
          }

          // 2. Meeting Date
          if (lead.meetingDate) {
            mappedEvents.push({
              id: `${lead.id}_meet_${lead.meetingDate}`,
              leadId: lead.id,
              lead,
              type: 'meeting',
              title: `Meeting: ${lead.prospectName}`,
              date: new Date(lead.meetingDate),
              dateStr: lead.meetingDate,
              remarks: `Product Focus: ${lead.productName || 'N/A'}`
            });
          }

          // 3. Next Follow-Up Date
          if (lead.nextFollowUpDate) {
            mappedEvents.push({
              id: `${lead.id}_followup_${lead.nextFollowUpDate}`,
              leadId: lead.id,
              lead,
              type: 'followup',
              title: `Follow-up: ${lead.prospectName}`,
              date: new Date(lead.nextFollowUpDate),
              dateStr: lead.nextFollowUpDate,
              remarks: `Current Status: ${lead.currentStatus}`
            });
          }
        });

        // Sort events by chronological order
        mappedEvents.sort((a, b) => a.date.getTime() - b.date.getTime());
        setEvents(mappedEvents);
      } catch (err) {
        console.error('Error fetching calendar events:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchLeadsAndBuildEvents();
  }, [user]);

  // Handle Filtering
  useEffect(() => {
    let result = events;

    // Type filter
    result = result.filter(e => {
      if (e.type === 'call') return filterTypes.call;
      if (e.type === 'meeting') return filterTypes.meeting;
      if (e.type === 'followup') return filterTypes.followup;
      return true;
    });

    // Text search filter
    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase();
      result = result.filter(e => 
        e.lead.prospectName.toLowerCase().includes(q) ||
        e.lead.mobile.toLowerCase().includes(q) ||
        (e.lead.productName && e.lead.productName.toLowerCase().includes(q)) ||
        (e.lead.campaignName && e.lead.campaignName.toLowerCase().includes(q))
      );
    }

    setFilteredEvents(result);
  }, [events, filterTypes, searchQuery]);

  // Calendar Math Helpers
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const getDaysInMonthCount = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
  const getFirstDayOfMonthIndex = (y: number, m: number) => new Date(y, m, 1).getDay();

  const navigatePeriod = (direction: 'prev' | 'next') => {
    const d = new Date(currentDate);
    if (viewMode === 'year') {
      d.setFullYear(direction === 'prev' ? year - 1 : year + 1);
    } else if (viewMode === 'month') {
      d.setMonth(direction === 'prev' ? month - 1 : month + 1);
    } else if (viewMode === 'week') {
      d.setDate(direction === 'prev' ? d.getDate() - 7 : d.getDate() + 7);
    } else if (viewMode === 'day') {
      d.setDate(direction === 'prev' ? d.getDate() - 1 : d.getDate() + 1);
    }
    setCurrentDate(d);
  };

  const getWeekDays = (date: Date) => {
    const current = new Date(date);
    const day = current.getDay();
    const sunday = new Date(current.setDate(current.getDate() - day));
    const days: Date[] = [];
    for (let i = 0; i < 7; i++) {
      days.push(new Date(sunday));
      sunday.setDate(sunday.getDate() + 1);
    }
    return days;
  };

  const isToday = (date: Date) => {
    const today = new Date();
    return date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear();
  };

  const isSameDay = (d1: Date, d2: Date) => {
    return d1.getDate() === d2.getDate() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getFullYear() === d2.getFullYear();
  };

  const getEventsForDay = (date: Date) => {
    return filteredEvents.filter(e => isSameDay(e.date, date));
  };

  const handleDayClick = (day: Date, dayEvents: CalendarEvent[]) => {
    if (viewMode === 'year') {
      setCurrentDate(day);
      setViewMode('month');
    } else {
      setSelectedDayEvents({ day, events: dayEvents });
    }
  };

  const handleLaunchTracking = (leadId: string) => {
    setSelectedEvent(null);
    setSelectedDayEvents(null);
    navigate(`/leads?leadId=${leadId}`);
  };

  // Render Year View
  const renderYearView = () => {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 animate-in fade-in duration-300">
        {MONTHS.map((mName, mIdx) => {
          const daysInM = getDaysInMonthCount(year, mIdx);
          const firstDayIdx = getFirstDayOfMonthIndex(year, mIdx);
          
          const monthDays: (Date | null)[] = [];
          for (let i = 0; i < firstDayIdx; i++) {
            monthDays.push(null);
          }
          for (let i = 1; i <= daysInM; i++) {
            monthDays.push(new Date(year, mIdx, i));
          }

          return (
            <div key={mName} className="bg-[#FBFAF8] border border-slate-200/60 p-4 rounded-none flex flex-col hover:border-[#978C21]/60 transition-all shadow-sm">
              <button 
                onClick={() => {
                  setCurrentDate(new Date(year, mIdx, 1));
                  setViewMode('month');
                }}
                className="text-xs font-black uppercase tracking-widest text-[#978C21] hover:text-[#83781C] text-left mb-3 cursor-pointer select-none leading-none border-b border-slate-100 pb-2"
              >
                {mName}
              </button>
              <div className="grid grid-cols-7 text-center gap-y-1">
                {DAYS_OF_WEEK.map(day => (
                  <span key={day} className="text-[8px] font-mono font-black text-slate-300 uppercase select-none">{day.charAt(0)}</span>
                ))}
                {monthDays.map((d, index) => {
                  if (!d) return <span key={`empty_${index}`} className="text-transparent" />;
                  
                  const dayEvents = getEventsForDay(d);
                  const hasEvents = dayEvents.length > 0;
                  const activeToday = isToday(d);

                  return (
                    <button
                      key={d.toString()}
                      onClick={() => handleDayClick(d, dayEvents)}
                      className={cn(
                        "w-6 h-6 mx-auto rounded-none flex flex-col items-center justify-center text-[9px] font-mono relative cursor-pointer",
                        activeToday ? "bg-slate-900 text-white font-bold" : "text-slate-600 hover:bg-slate-100",
                        hasEvents && !activeToday && "font-black text-[#978C21]"
                      )}
                    >
                      <span>{d.getDate()}</span>
                      {hasEvents && (
                        <span className={cn(
                          "absolute bottom-0.5 w-1 h-1 rounded-full",
                          activeToday ? "bg-[#978C21]" : "bg-[#978C21]"
                        )} />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // Render Month View
  const renderMonthView = () => {
    const daysInM = getDaysInMonthCount(year, month);
    const firstDayIdx = getFirstDayOfMonthIndex(year, month);
    
    const cells: (Date | null)[] = [];
    // Padding for previous month
    for (let i = 0; i < firstDayIdx; i++) {
      cells.push(null);
    }
    // Days of current month
    for (let i = 1; i <= daysInM; i++) {
      cells.push(new Date(year, month, i));
    }

    return (
      <div className="border border-slate-200/60 rounded-sm overflow-hidden bg-[#FBFAF8] shadow-sm animate-in fade-in duration-300">
        <div className="grid grid-cols-7 text-center bg-white border-b border-slate-200/60 divide-x divide-slate-100">
          {DAYS_OF_WEEK.map(day => (
            <div key={day} className="py-3 text-[10px] font-black tracking-widest text-slate-400 uppercase italic">
              {day}
            </div>
          ))}
        </div>
        
        <div className="grid grid-cols-7 divide-x divide-y divide-slate-100 bg-[#FBFAF8] min-h-[500px]">
          {cells.map((day, index) => {
            if (!day) {
              return <div key={`empty_${index}`} className="bg-slate-50/20 p-2 min-h-[90px] border-b border-slate-100/40" />;
            }

            const dayEvents = getEventsForDay(day);
            const activeToday = isToday(day);

            return (
              <div 
                key={day.toString()} 
                className={cn(
                  "p-2 min-h-[100px] flex flex-col justify-between hover:bg-slate-50/50 transition-colors group relative",
                  activeToday && "bg-[#F9F9F4]/40"
                )}
              >
                <div className="flex justify-between items-start mb-2">
                  <span className={cn(
                    "text-xs font-mono font-bold px-1.5 py-0.5 rounded-none leading-none select-none",
                    activeToday ? "bg-[#978C21] text-white font-black shadow-sm" : "text-slate-500"
                  )}>
                    {day.getDate()}
                  </span>
                  
                  {dayEvents.length > 0 && (
                    <button
                      onClick={() => handleDayClick(day, dayEvents)}
                      className="text-[8px] font-black text-[#978C21] uppercase tracking-wider hover:underline leading-none p-1 cursor-pointer"
                    >
                      {dayEvents.length} Tasks
                    </button>
                  )}
                </div>

                <div className="flex-1 space-y-1 overflow-y-auto max-h-[80px] scrollbar-thin pr-0.5">
                  {dayEvents.slice(0, 3).map(event => (
                    <div
                      key={event.id}
                      onClick={() => setSelectedEvent(event)}
                      className={cn(
                        "p-1.5 text-[9px] font-black uppercase tracking-wider leading-snug cursor-pointer flex flex-col border border-l-2 text-left truncate transition-all hover:translate-x-0.5",
                        event.type === 'meeting' && "bg-amber-50 text-amber-700 border-amber-200 border-l-amber-500",
                        event.type === 'call' && "bg-sky-50 text-sky-700 border-sky-250 border-l-sky-500",
                        event.type === 'followup' && "bg-emerald-50 text-emerald-700 border-emerald-200 border-l-emerald-500"
                      )}
                    >
                      <span className="truncate font-black">{event.lead.prospectName}</span>
                      <span className="text-[7.5px] font-mono text-slate-450 leading-none flex items-center gap-0.5 mt-0.5 font-bold">
                        <Clock className="w-2.5 h-2.5 shrink-0" />
                        {event.date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  ))}
                  
                  {dayEvents.length > 3 && (
                    <button
                      onClick={() => handleDayClick(day, dayEvents)}
                      className="w-full text-center py-1 text-[8px] font-black text-slate-400 hover:text-[#978C21] uppercase tracking-widest block border border-dashed border-slate-200 bg-white"
                    >
                      + {dayEvents.length - 3} More
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Render Week View
  const renderWeekView = () => {
    const weekDays = getWeekDays(currentDate);

    return (
      <div className="border border-slate-200/60 rounded-sm overflow-hidden bg-white shadow-sm animate-in fade-in duration-300">
        <div className="grid grid-cols-7 divide-x divide-slate-100 text-center border-b border-slate-200 bg-[#FBFAF8]">
          {weekDays.map(day => {
            const activeToday = isToday(day);
            const dayEvents = getEventsForDay(day);

            return (
              <div 
                key={day.toString()} 
                onClick={() => handleDayClick(day, dayEvents)}
                className={cn(
                  "py-4 flex flex-col items-center justify-center gap-1 select-none cursor-pointer hover:bg-slate-100/40 transition-colors",
                  activeToday && "bg-[#F9F9F4]/70"
                )}
              >
                <span className="text-[9px] font-mono font-black text-slate-400 uppercase tracking-widest italic">{DAYS_OF_WEEK[day.getDay()]}</span>
                <span className={cn(
                  "text-lg font-mono font-black tracking-tighter w-8 h-8 flex items-center justify-center rounded-none leading-none",
                  activeToday ? "bg-[#978C21] text-white shadow-md shadow-[#978C21]/15" : "text-slate-800"
                )}>
                  {day.getDate()}
                </span>
                <span className="text-[8px] font-black text-slate-400 uppercase tracking-wider">
                  {dayEvents.length} Active Tasks
                </span>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-7 divide-x divide-slate-100 bg-[#FBFAF8] min-h-[420px]">
          {weekDays.map(day => {
            const dayEvents = getEventsForDay(day);
            return (
              <div key={day.toString()} className="p-3 space-y-3 bg-[#FBFAF8]">
                {dayEvents.length === 0 ? (
                  <div className="h-full flex items-center justify-center py-20 text-[8px] text-slate-350 uppercase font-black font-mono tracking-widest italic text-center select-none">
                    No Tasks
                  </div>
                ) : (
                  dayEvents.map(event => (
                    <div
                      key={event.id}
                      onClick={() => setSelectedEvent(event)}
                      className={cn(
                        "p-3 rounded-none border border-l-4 text-left cursor-pointer transition-all hover:shadow-md hover:-translate-y-0.5 space-y-1.5",
                        event.type === 'meeting' && "bg-amber-50 text-amber-800 border-amber-250 border-l-amber-500",
                        event.type === 'call' && "bg-sky-50 text-sky-800 border-sky-250 border-l-sky-500",
                        event.type === 'followup' && "bg-emerald-50 text-emerald-805 border-emerald-250 border-l-emerald-500"
                      )}
                    >
                      <span className="text-[10px] font-black uppercase tracking-wider block truncate">{event.lead.prospectName}</span>
                      <p className="text-[8px] uppercase tracking-wider opacity-90 line-clamp-2">{event.remarks || 'No notes specified.'}</p>
                      
                      <div className="pt-1.5 border-t border-black/5 flex items-center justify-between text-[8px] font-mono font-bold opacity-80">
                        <span className="flex items-center gap-0.5">
                          <Clock className="w-2.5 h-2.5 shrink-0" />
                          {event.date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <span className="uppercase">{event.type}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Render Day View
  const renderDayView = () => {
    const dayEvents = getEventsForDay(currentDate);

    return (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start animate-in fade-in duration-300">
        <div className="lg:col-span-4 bg-[#FBFAF8] border border-slate-200/60 p-6 rounded-sm space-y-6">
          <div className="space-y-1 pb-4 border-b border-slate-100">
            <span className="text-[9px] font-black text-slate-300 uppercase tracking-widest italic block">{DAYS_OF_WEEK[currentDate.getDay()]}</span>
            <h3 className="text-xl font-black uppercase tracking-tight text-slate-950">
              {MONTHS[currentDate.getMonth()]} {currentDate.getDate()}, {currentDate.getFullYear()}
            </h3>
            <p className="text-[9px] text-[#978C21] font-black uppercase tracking-wider">
              {dayEvents.length} Registered tasks for today
            </p>
          </div>

          <div className="space-y-4">
            <div className="p-4 bg-white border border-slate-150 rounded-sm space-y-3">
              <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest italic block">Daily Overview stats</span>
              <div className="grid grid-cols-3 text-center divide-x divide-slate-100">
                <div className="px-1.5">
                  <span className="text-lg font-black text-sky-600 font-mono italic">{dayEvents.filter(e => e.type === 'call').length}</span>
                  <span className="text-[8px] font-bold text-slate-400 uppercase block tracking-wider mt-1">Calls</span>
                </div>
                <div className="px-1.5">
                  <span className="text-lg font-black text-amber-600 font-mono italic">{dayEvents.filter(e => e.type === 'meeting').length}</span>
                  <span className="text-[8px] font-bold text-slate-400 uppercase block tracking-wider mt-1">Meetings</span>
                </div>
                <div className="px-1.5">
                  <span className="text-lg font-black text-emerald-600 font-mono italic">{dayEvents.filter(e => e.type === 'followup').length}</span>
                  <span className="text-[8px] font-bold text-slate-400 uppercase block tracking-wider mt-1">Follows</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-8 bg-white border border-slate-250/60 p-6 rounded-sm space-y-4 shadow-sm min-h-[350px]">
          <h4 className="text-xs font-black uppercase tracking-widest text-slate-900 border-b border-slate-100 pb-3">Hour-by-Hour Task Agenda</h4>
          
          {dayEvents.length === 0 ? (
            <div className="py-20 border border-dashed border-slate-200 rounded-sm text-center flex flex-col justify-center items-center gap-4 bg-[#FBFAF8]">
              <span className="w-10 h-10 bg-slate-50 border border-slate-150 flex items-center justify-center text-slate-400 rounded-full font-mono text-xs">0</span>
              <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest italic">
                There are no actions scheduled for this date.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {dayEvents.map(event => (
                <div
                  key={event.id}
                  onClick={() => setSelectedEvent(event)}
                  className={cn(
                    "p-4 border rounded-none flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 cursor-pointer hover:shadow-md transition-all group border-l-4",
                    event.type === 'meeting' && "bg-amber-50/40 text-amber-800 border-slate-200 border-l-amber-500",
                    event.type === 'call' && "bg-sky-50/40 text-sky-800 border-slate-200 border-l-sky-500",
                    event.type === 'followup' && "bg-emerald-50/40 text-emerald-800 border-slate-200 border-l-emerald-500"
                  )}
                >
                  <div className="space-y-1.5 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={cn(
                        "text-[8px] font-black uppercase tracking-widest px-2 py-0.5 rounded-none border",
                        event.type === 'meeting' && "bg-amber-100 text-amber-700 border-amber-200",
                        event.type === 'call' && "bg-sky-100 text-sky-700 border-sky-200",
                        event.type === 'followup' && "bg-emerald-100 text-emerald-700 border-emerald-200"
                      )}>
                        {event.type}
                      </span>
                      <span className="text-[9px] font-mono text-slate-400 tracking-wider">
                        ⏰ {event.date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <h5 className="text-xs font-black uppercase tracking-wide text-slate-900">{event.lead.prospectName}</h5>
                    <p className="text-[9px] text-slate-500 font-medium leading-relaxed italic">{event.remarks || 'No notes defined.'}</p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleLaunchTracking(event.leadId);
                      }}
                      className="px-3 py-1.5 bg-white border border-slate-200 hover:border-[#978C21] text-slate-650 hover:text-[#978C21] text-[9px] font-black uppercase tracking-widest flex items-center gap-1 cursor-pointer"
                    >
                      Open <ExternalLink className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={cn("space-y-8 max-w-7xl mx-auto", embedded ? "pb-4" : "space-y-10 pb-24")}>
      {/* Header Panel */}
      {embedded ? (
        <div className="border-b border-slate-100 pb-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h4 className="text-[28px] font-black text-brand-text tracking-tighter italic leading-none serif flex items-center gap-3">
              <CalendarIcon className="w-6 h-6 text-[#978C21]" />
              Task Calendar
            </h4>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-2 ml-0.5">Role Action Schedule & Follow-up Agenda</p>
          </div>
          {/* View Mode Switcher */}
          <div className="flex items-center gap-1 border border-slate-200/60 p-1 rounded-sm bg-[#FBFAF8] shadow-sm">
            {(['year', 'month', 'week', 'day'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={cn(
                  "px-3 py-1.5 text-[8px] font-black uppercase tracking-wider italic cursor-pointer transition-all",
                  viewMode === mode 
                    ? "bg-[#978C21] text-white shadow-md shadow-[#978C21]/15" 
                    : "text-slate-400 hover:text-slate-800 hover:bg-slate-100"
                )}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 border-b border-slate-100 pb-10">
          <div className="flex items-center gap-6">
            <div className="w-16 h-16 bg-[#F9F9F4] rounded-sm flex items-center justify-center text-[#978C21] border border-slate-100 shadow-sm">
              <CalendarIcon className="w-8 h-8" />
            </div>
            <div>
              <h1 className="text-4xl font-black tracking-tighter text-slate-900 uppercase italic serif leading-none">Task Calendar</h1>
              <p className="text-slate-400 font-bold text-[10px] uppercase tracking-[0.3em] mt-3 italic">Unified Schedule & Action Agenda Interface</p>
            </div>
          </div>

          {/* View Mode Switcher */}
          <div className="flex items-center gap-1 border border-slate-200/60 p-1.5 rounded-sm bg-[#FBFAF8] shadow-sm">
            {(['year', 'month', 'week', 'day'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={cn(
                  "px-4 py-2 text-[9px] font-black uppercase tracking-wider italic cursor-pointer transition-all",
                  viewMode === mode 
                    ? "bg-[#978C21] text-white shadow-md shadow-[#978C21]/15" 
                    : "text-slate-400 hover:text-slate-800 hover:bg-slate-100"
                )}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Control Console */}
      <div className="bg-[#FBFAF8] border border-slate-200 p-4 rounded-sm flex flex-col md:flex-row justify-between items-center gap-4">
        {/* Navigation buttons */}
        <div className="flex items-center gap-3 w-full md:w-auto">
          <button
            onClick={() => navigatePeriod('prev')}
            className="p-2 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 cursor-pointer rounded-none"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          
          <span className="text-xs font-black uppercase tracking-widest text-slate-850 font-mono select-none min-w-[130px] text-center italic">
            {viewMode === 'year' && `${year}`}
            {viewMode === 'month' && `${MONTHS[month]} ${year}`}
            {viewMode === 'week' && `Week of ${getWeekDays(currentDate)[0].getDate()} ${MONTHS[getWeekDays(currentDate)[0].getMonth()]}`}
            {viewMode === 'day' && `${currentDate.getDate()} ${MONTHS[month]} ${year}`}
          </span>

          <button
            onClick={() => navigatePeriod('next')}
            className="p-2 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 cursor-pointer rounded-none"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          <button
            onClick={() => setCurrentDate(new Date())}
            className="px-3.5 py-2.5 border border-slate-200 bg-white hover:bg-slate-50 text-[9px] font-black uppercase tracking-widest text-slate-600 cursor-pointer leading-none"
          >
            Today
          </button>
        </div>

        {/* Dynamic Filters */}
        <div className="flex flex-wrap items-center gap-4 w-full md:w-auto justify-end">
          {/* Checkbox controls for filter types */}
          <div className="flex items-center gap-3 bg-white border border-slate-200 p-1.5 px-3">
            <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest italic mr-1">LEGEND:</span>
            
            <label className="flex items-center gap-1.5 cursor-pointer text-[9px] font-black uppercase tracking-wider text-sky-700 select-none">
              <input 
                type="checkbox" 
                checked={filterTypes.call} 
                onChange={(e) => setFilterTypes({ ...filterTypes, call: e.target.checked })}
                className="w-3.5 h-3.5 accent-sky-500" 
              />
              Calls
            </label>

            <label className="flex items-center gap-1.5 cursor-pointer text-[9px] font-black uppercase tracking-wider text-amber-700 select-none">
              <input 
                type="checkbox" 
                checked={filterTypes.meeting} 
                onChange={(e) => setFilterTypes({ ...filterTypes, meeting: e.target.checked })}
                className="w-3.5 h-3.5 accent-amber-500" 
              />
              Meetings
            </label>

            <label className="flex items-center gap-1.5 cursor-pointer text-[9px] font-black uppercase tracking-wider text-emerald-700 select-none">
              <input 
                type="checkbox" 
                checked={filterTypes.followup} 
                onChange={(e) => setFilterTypes({ ...filterTypes, followup: e.target.checked })}
                className="w-3.5 h-3.5 accent-emerald-500" 
              />
              Followups
            </label>
          </div>

          {/* Quick Filter Search */}
          <div className="flex items-center gap-2 bg-white border border-slate-200 px-3 py-2 text-xs w-full max-w-[200px]">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search Prospect..."
              className="outline-none bg-transparent w-full text-[10px] font-black uppercase tracking-wider placeholder:text-slate-300 font-mono"
            />
          </div>
        </div>
      </div>

      {/* Main Calendar Body */}
      {loading ? (
        <div className="py-32 flex flex-col justify-center items-center gap-4">
          <div className="w-10 h-10 border-4 border-slate-100 border-t-[#978C21] rounded-full animate-spin" />
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest italic animate-pulse">Syncing Agenda schedules...</p>
        </div>
      ) : (
        <div className="min-h-[400px]">
          {viewMode === 'year' && renderYearView()}
          {viewMode === 'month' && renderMonthView()}
          {viewMode === 'week' && renderWeekView()}
          {viewMode === 'day' && renderDayView()}
        </div>
      )}

      {/* ----------------------------------------------------
          MODAL: EVENT DETAILED EXPLORER
          ---------------------------------------------------- */}
      <AnimatePresence>
        {selectedEvent && (
          <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 15 }}
              className="bg-white border border-slate-200 w-full max-w-lg shadow-2xl overflow-hidden"
            >
              {/* Header */}
              <div className="bg-[#FBFAF8] p-6 border-b border-slate-100 flex items-center justify-between">
                <div className="space-y-1">
                  <span className={cn(
                    "inline-flex items-center gap-1.5 px-2.5 py-1 border text-[8px] font-black uppercase tracking-widest",
                    selectedEvent.type === 'meeting' && "bg-amber-50 text-amber-700 border-amber-200",
                    selectedEvent.type === 'call' && "bg-sky-50 text-sky-700 border-sky-200",
                    selectedEvent.type === 'followup' && "bg-emerald-50 text-emerald-700 border-emerald-200"
                  )}>
                    {selectedEvent.type === 'meeting' && <Video className="w-3 h-3" />}
                    {selectedEvent.type === 'call' && <Phone className="w-3 h-3" />}
                    {selectedEvent.type === 'followup' && <CalendarIcon className="w-3 h-3" />}
                    {selectedEvent.type} Agenda Event
                  </span>
                  <h3 className="text-base font-black uppercase tracking-tight text-slate-900 mt-2">
                    {selectedEvent.lead.prospectName}
                  </h3>
                </div>
                <button
                  onClick={() => setSelectedEvent(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 transition-colors cursor-pointer border border-slate-100 bg-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Body details */}
              <div className="p-6 space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  {/* Scheduled Time */}
                  <div className="p-3 bg-slate-50 border border-slate-100 space-y-1">
                    <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest block">Date & Time</span>
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-800 font-mono leading-none block">
                      {selectedEvent.date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </span>
                    <span className="text-[9px] font-mono font-bold text-[#978C21] mt-0.5 block">
                      ⏰ {selectedEvent.date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>

                  {/* Status */}
                  <div className="p-3 bg-slate-50 border border-slate-100 space-y-1">
                    <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest block">Current Pipeline Status</span>
                    <span className="text-[10px] font-black uppercase tracking-wider text-[#978C21] leading-none block mt-1">
                      {selectedEvent.lead.currentStatus}
                    </span>
                    <span className="text-[8px] font-mono font-bold text-slate-400 uppercase block mt-1">
                      Economic Potential: {selectedEvent.lead.projectedNCP > 0 ? `${selectedEvent.lead.projectedNCP} NCP` : 'None Lock'}
                    </span>
                  </div>
                </div>

                {/* Demographics details */}
                <div className="space-y-3">
                  <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest italic block border-b border-slate-100 pb-1">Client Demographics</span>
                  
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[10px] uppercase font-mono">
                    <div className="flex items-center gap-2 text-slate-500 font-bold">
                      <Phone className="w-3.5 h-3.5 text-slate-300" />
                      <span>Mobile: <span className="text-slate-800 font-black">{selectedEvent.lead.mobile}</span></span>
                    </div>

                    <div className="flex items-center gap-2 text-slate-500 font-bold">
                      <Tag className="w-3.5 h-3.5 text-slate-300" />
                      <span>Campaign: <span className="text-slate-800 font-black">{selectedEvent.lead.campaignName}</span></span>
                    </div>

                    <div className="flex items-center gap-2 text-slate-500 font-bold">
                      <Layers className="w-3.5 h-3.5 text-slate-300" />
                      <span>Product Name: <span className="text-slate-800 font-black">{selectedEvent.lead.productName}</span></span>
                    </div>

                    <div className="flex items-center gap-2 text-slate-500 font-bold">
                      <MapPin className="w-3.5 h-3.5 text-slate-300" />
                      <span className="truncate">Area: <span className="text-slate-800 font-black" title={selectedEvent.lead.area}>{selectedEvent.lead.area}</span></span>
                    </div>
                  </div>
                </div>

                {/* Remarks */}
                <div className="p-4 bg-[#FBFAF8] border border-slate-200/60 rounded-sm space-y-2">
                  <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest italic block">Notes & contextual Remarks</span>
                  <p className="text-[10px] text-slate-600 font-medium leading-relaxed italic">
                    "{selectedEvent.remarks || 'No detailed remarks recorded for this agenda slot.'}"
                  </p>
                </div>
              </div>

              {/* Footer action */}
              <div className="p-6 bg-[#FBFAF8] border-t border-slate-100 flex gap-3 justify-end">
                <button
                  onClick={() => setSelectedEvent(null)}
                  className="px-4.5 py-3 border border-slate-200 text-slate-550 hover:bg-slate-50 font-black text-[10px] uppercase tracking-widest italic cursor-pointer"
                >
                  Close Panel
                </button>

                <button
                  onClick={() => handleLaunchTracking(selectedEvent.leadId)}
                  className="px-5 py-3 bg-[#978C21] hover:bg-[#83781C] text-white font-black text-[10px] uppercase tracking-widest italic transition-colors shadow-lg shadow-[#978C21]/15 flex items-center gap-1.5 cursor-pointer"
                >
                  Launch Tracking Terminal
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ----------------------------------------------------
          MODAL: DAY AGENDA BROWSER
          ---------------------------------------------------- */}
      <AnimatePresence>
        {selectedDayEvents && (
          <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 15 }}
              className="bg-white border border-slate-200 w-full max-w-xl shadow-2xl overflow-hidden"
            >
              {/* Header */}
              <div className="bg-[#FBFAF8] p-6 border-b border-slate-100 flex items-center justify-between">
                <div className="space-y-1">
                  <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest italic block">
                    {DAYS_OF_WEEK[selectedDayEvents.day.getDay()]} Agenda List
                  </span>
                  <h3 className="text-base font-black uppercase tracking-tight text-slate-900">
                    {MONTHS[selectedDayEvents.day.getMonth()]} {selectedDayEvents.day.getDate()}, {selectedDayEvents.day.getFullYear()}
                  </h3>
                </div>
                <button
                  onClick={() => setSelectedDayEvents(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 transition-colors cursor-pointer border border-slate-100 bg-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* List */}
              <div className="p-6 max-h-[350px] overflow-y-auto divide-y divide-slate-100 scrollbar-thin space-y-4">
                {selectedDayEvents.events.length === 0 ? (
                  <div className="py-12 text-center text-[10px] text-slate-400 font-bold uppercase tracking-widest italic font-mono">
                    No active tasks scheduled for this day.
                  </div>
                ) : (
                  selectedDayEvents.events.map(event => (
                    <div 
                      key={event.id}
                      onClick={() => {
                        setSelectedEvent(event);
                      }}
                      className="py-3 flex items-start gap-4 hover:bg-slate-55/10 rounded-sm cursor-pointer transition-colors group select-none"
                    >
                      <div className={cn(
                        "w-2.5 h-12 rounded-none shrink-0",
                        event.type === 'meeting' && "bg-amber-400",
                        event.type === 'call' && "bg-sky-400",
                        event.type === 'followup' && "bg-emerald-400"
                      )} />
                      
                      <div className="space-y-1 flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            "text-[7px] font-black uppercase tracking-widest px-1.5 py-0.2 rounded-none border leading-none",
                            event.type === 'meeting' && "bg-amber-50 border-amber-200 text-amber-600",
                            event.type === 'call' && "bg-sky-50 border-sky-200 text-sky-600",
                            event.type === 'followup' && "bg-emerald-50 border-emerald-200 text-emerald-600"
                          )}>
                            {event.type}
                          </span>
                          <span className="text-[8.5px] font-mono text-slate-400 font-black">
                            ⏰ {event.date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        <h4 className="text-xs font-black uppercase text-slate-850 truncate group-hover:text-[#978C21] transition-colors">{event.lead.prospectName}</h4>
                        <p className="text-[9px] text-slate-450 line-clamp-1 italic font-medium">{event.remarks || 'No notes registered.'}</p>
                      </div>

                      <ChevronRight className="w-4 h-4 text-slate-300 shrink-0 self-center group-hover:translate-x-0.5 transition-transform" />
                    </div>
                  ))
                )}
              </div>

              {/* Footer */}
              <div className="p-4 bg-[#FBFAF8] border-t border-slate-100 flex justify-end">
                <button
                  onClick={() => setSelectedDayEvents(null)}
                  className="px-4.5 py-2.5 border border-slate-200 text-slate-500 hover:bg-slate-50 font-black text-[10px] uppercase tracking-widest italic cursor-pointer"
                >
                  Close Agenda List
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
